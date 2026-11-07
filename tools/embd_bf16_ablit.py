"""tools/embd_bf16_ablit.py - the BF16 token embedding of an abliterated model whose BF16 checkpoint you cannot read.

    python tools/embd_bf16_ablit.py --official <embed_tokens.bf16> --gguf <abliterated model.gguf> --out <token-embd-bf16.gguf>

Abliteration removes one refusal direction r from the residual stream, the token embedding included:
E_abl = E - (E r) r^T.  A low-bit GGUF of the abliterated model keeps that table only as, for example, IQ4_XS (about
8% relative error).  This tool takes the base model's table (`--official`: the raw BF16 bytes of
model.language_model.embed_tokens.weight, [n_vocab, n_embd] row-major, cut out of the base checkpoint's safetensors
shard), finds r as the main direction of (base - dequantized GGUF), checks that removing it accounts for the
difference (alpha near 1, the rest is quantization noise at the level of a random direction, row norms unchanged),
and writes E - (E r) r^T rounded to BF16 (nearest even) as the one-tensor GGUF `--embd-gguf` reads.  It refuses when the
difference is not one direction: then the model changed its embedding some other way and this table would be wrong.
"""
import argparse
import os
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from embd_bf16_pack import write_header  # noqa: E402

ROWS = 4096   # rows per chunk; the buffers are reused (fresh large arrays are slow next to tens of GiB of pinned RAM)


def _gguf_embd(src):
    import gguf_reader as G
    g = G.GGUFFile(src)
    t = next((t for t in g.tensors if t.name == "token_embd.weight"), None)
    if t is None or len(t.shape) != 2 or t.expected_bytes() is None:
        sys.exit("%s: no 2-D token_embd.weight of a known type" % src)
    return g, t


def _dequant_rows(job):
    src, out, s = job
    from _paths import add_gguf_py
    add_gguf_py()
    from gguf import GGMLQuantizationType as Q, quants
    g, t = _gguf_embd(src)
    dim, vocab = int(t.shape[0]), int(t.shape[1])
    row = t.expected_bytes() // vocab
    e = min(vocab, s + ROWS)
    raw = np.asarray(np.memmap(src, dtype=np.uint8, mode="r")[g.data_start + t.offset + s * row: g.data_start + t.offset + e * row])
    o = np.lib.format.open_memmap(out, mode="r+")
    o[s:e] = quants.dequantize(raw.reshape(e - s, row), Q(t.type_id)).reshape(e - s, dim)
    o.flush()


def dequant_gguf_embd(src, scratch):
    """The GGUF's token_embd.weight as float32 rows in the file `scratch` (a .npy, one worker per core)."""
    from multiprocessing import Pool
    _, t = _gguf_embd(src)
    dim, vocab = int(t.shape[0]), int(t.shape[1])
    np.lib.format.open_memmap(scratch, mode="w+", dtype=np.float32, shape=(vocab, dim)).flush()
    with Pool(os.cpu_count() or 4) as p:
        p.map(_dequant_rows, [(src, scratch, s) for s in range(0, vocab, ROWS)])
    return np.load(scratch, mmap_mode="r"), t.type_name


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--official", required=True, help="raw BF16 bytes of the base model's embed_tokens.weight")
    ap.add_argument("--gguf", required=True, help="the abliterated model's GGUF (first shard)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    scratch = out.with_suffix(".dequant.npy")
    D, qname = dequant_gguf_embd(pathlib.Path(a.gguf).absolute(), scratch)
    vocab, dim = D.shape
    Ob = np.memmap(a.official, dtype=np.uint16, mode="r")
    if Ob.size != vocab * dim:
        sys.exit("--official holds %d values, the GGUF's table %d x %d" % (Ob.size, vocab, dim))
    Ob = Ob.reshape(vocab, dim)
    U = np.empty((ROWS, dim), np.uint32)
    R = np.empty((ROWS, dim), np.float32)
    X = np.empty((ROWS, dim), np.float32)
    P = np.empty(ROWS, np.float32)

    def removed(O):   # O - (O r) r^T into X
        n = O.shape[0]
        np.matmul(O, r, out=P[:n])
        np.outer(P[:n], r, out=X[:n])
        np.subtract(O, X[:n], out=X[:n])
        return X[:n]

    def chunks():
        for s in range(0, vocab, ROWS):
            n = min(ROWS, vocab - s)
            np.left_shift(Ob[s:s + n], 16, out=U[:n], dtype=np.uint32)
            O = U[:n].view(np.float32)
            np.subtract(O, D[s:s + n], out=R[:n])
            yield s, O, D[s:s + n], R[:n]

    v = np.random.default_rng(0).standard_normal(dim).astype(np.float32)
    for _ in range(12):   # power iteration on R^T R
        w = np.zeros(dim, np.float64)
        for _, _, _, r_ in chunks():
            w += r_.T @ (r_ @ v)
        lam = float(np.linalg.norm(w))
        v = (w / lam).astype(np.float32)
    r = v
    tot = sum(float(np.einsum("ij,ij->", r_, r_)) for _, _, _, r_ in chunks())
    share = lam / tot
    num = den = 0.0
    for _, O, d, _ in chunks():
        po = O @ r
        num += float(po @ (d @ r))
        den += float(po @ po)
    alpha = 1.0 - num / den
    u = np.random.default_rng(1).standard_normal(dim).astype(np.float32)
    u /= np.linalg.norm(u)
    on_r = on_u = 0.0
    for _, O, d, _ in chunks():
        E = removed(O)
        np.subtract(E, d, out=E)
        on_r += float(np.abs(E @ r).sum())
        on_u += float(np.abs(E @ u).sum())
    print("token_embd.weight %d x %d %s; the base table's difference: %.2f%% of it on one direction (noise: %.3f%%), "
          "alpha %.4f; what is left on that direction %.6f vs %.6f on a random one"
          % (vocab, dim, qname, 100 * share, 100 / dim, alpha, on_r / vocab, on_u / vocab), flush=True)
    if share < 20.0 / dim or abs(alpha - 1.0) > 0.05 or on_r > 1.5 * on_u:
        sys.exit("the difference is not one removed direction: this tool cannot rebuild the table")
    tmp = out.with_suffix(out.suffix + ".part")
    head = write_header(dim, vocab, pathlib.Path(a.gguf).name,
                        "token embedding, base BF16 minus the abliterated GGUF's refusal direction")
    with open(tmp, "wb") as f:
        f.write(head)
        for _, O, _, _ in chunks():
            b = removed(O).view(np.uint32)
            b = ((b + 0x7FFF + ((b >> 16) & 1)) >> 16).astype(np.uint16)   # round to nearest even
            f.write(b.tobytes())
    tmp.replace(out)
    del D
    scratch.unlink(missing_ok=True)
    print("wrote %s" % out)


if __name__ == "__main__":
    main()
