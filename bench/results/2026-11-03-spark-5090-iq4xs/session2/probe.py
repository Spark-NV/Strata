"""Fixed-length decode + prefill probe against a running Strata server. Prints per-run tok/s and output hash."""
import argparse, hashlib, json, statistics, sys, time, urllib.request
sys.path.insert(0, "/home/spark/Apps/Strata/bench/api")
import strata_benchmark as sb

STORY = ("Write the beginning of a very long original fantasy novel in continuous prose. This is chapter one of a "
         "5000-word story. Keep writing vivid narrative paragraphs until the output limit; do not conclude the chapter.")
CODE = ("Write a long, complete Python module implementing a red-black tree with insert, delete, search, iteration "
        "and thorough docstrings. Output only code.")

def run(base, model, prompt, n, tag):
    rows = []
    for i in range(n):
        case = {"prompt": f"[{tag} {i}] " + prompt, "max_tokens": 256}
        r = sb.request_case(base, model, case, 600)
        rows.append(r)
    return rows

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8082")
ap.add_argument("--n", type=int, default=8)
ap.add_argument("--skip", type=int, default=2)
ap.add_argument("--out")
ap.add_argument("--prefill", action="store_true")
a = ap.parse_args()
model = sb.get_json(a.base + "/health").get("model") or ""
res = {}
for tag, p in (("story", STORY), ("code", CODE)):
    rows = run(a.base, model, p, a.n, tag)
    d = [r["decode_tok_s"] for r in rows[a.skip:]]
    acc = sum(r["drafts_accepted"] or 0 for r in rows) / max(1, sum(r["drafts_offered"] or 0 for r in rows))
    print(f"{tag}: decode median {statistics.median(d):.1f} mean {statistics.mean(d):.1f} all {[round(x,1) for x in d]} out {[r['output_tokens'] for r in rows]} acc {acc:.3f}")
    res[tag] = rows
if a.prefill:
    for name, words in (("p8k", 1500), ("p32k", 5200)):
        rows = []
        for i in range(3):
            case = {"prompt": f"[{name} {time.time()}] Read this reference text and reply with exactly BENCHMARK-ACK.\n\n" + sb.corpus(words, name + str(i)), "max_tokens": 16}
            rows.append(sb.request_case(a.base, model, case, 600))
        print(f"{name}: prompt tok/s {[r['prompt_tok_s'] for r in rows]} ans {[r['answer_preview'][:20] for r in rows]}")
        res[name] = rows
if a.out:
    json.dump(res, open(a.out, "w"), indent=1)
