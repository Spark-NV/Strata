"""Seeded sampled probe: the 16 mixed prompts plus story and code, 256 tokens each, the profile's (Qwen's recommended)
sampling with a fixed seed per prompt.  With the tiers frozen (--adapt-every 100000) two engines that compute the same
numbers write the same text, so their decode times compare on equal work.  Prints total tok/s over prompts 3.. and a
hash of all replies (equal hashes = equal texts)."""
import argparse, hashlib, json, sys, time
sys.path.insert(0, "/home/spark/Apps/Strata/bench/api")
import strata_benchmark as sb
import ast, os
# the 16 mixed prompts, read out of probe2.py (importing it would run its probe)
_tree = ast.parse(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe2.py")).read())
P = next(ast.literal_eval(n.value) for n in _tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "P")

STORY = ("Write the beginning of a very long original fantasy novel in continuous prose. Keep writing vivid narrative "
         "paragraphs until the output limit; do not conclude the chapter.")
CODE = ("Write a long, complete Python module implementing a red-black tree with insert, delete, search, iteration "
        "and thorough docstrings. Output only code.")

ap = argparse.ArgumentParser(); ap.add_argument("--base", default="http://127.0.0.1:8090"); ap.add_argument("--out")
a = ap.parse_args()
model = sb.get_json(a.base + "/health").get("model") or ""
rows, h = [], hashlib.sha256()
for i, p in enumerate([STORY, CODE] + P):
    t0 = time.monotonic()
    r = sb.post_json(a.base + "/v1/chat/completions", {"model": model, "messages": [{"role": "user", "content": p}],
                     "max_tokens": 256, "seed": 1000 + i, "reasoning_effort": "none"}, 600)
    t = r["choices"][0]["message"]["content"]
    tm = r.get("timings", {})
    h.update(t.encode())
    rows.append({"i": i, "tokens": r.get("usage", {}).get("completion_tokens"), "decode_ms": tm.get("predicted_ms"),
                 "sha": hashlib.sha256(t.encode()).hexdigest()[:12], "wall": time.monotonic() - t0})
m = rows[2:]
tok = sum(x["tokens"] for x in m); ms = sum(x["decode_ms"] for x in m)
print(f"seeded: total decode {tok / ms * 1000:.1f} tok/s over {len(m)} prompts ({tok} tokens); story {rows[0]['tokens'] / rows[0]['decode_ms'] * 1000:.1f}, "
      f"code {rows[1]['tokens'] / rows[1]['decode_ms'] * 1000:.1f}; texts {h.hexdigest()[:16]}")
print("per-prompt:", " ".join(x["sha"][:6] for x in rows))
if a.out: json.dump(rows, open(a.out, "w"), indent=1)
