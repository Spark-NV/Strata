"""Greedy identity: python greedy.py --base URL --out FILE. Three prompts, 300 tokens each, temperature 0; prints a hash of
each reply's full text so two servers (frozen tiers: --adapt-every 100000) can be compared token for token."""
import argparse, hashlib, json, sys
sys.path.insert(0, "/home/spark/Apps/Strata/bench/api")
import strata_benchmark as sb

P = [
    "Explain how a refrigerator moves heat from inside to outside, in detail.",
    "Write a Rust function that parses an INI file into a HashMap, with error handling and tests.",
    "Tell a long bedtime story about a lighthouse keeper and a talking seagull.",
]
ap = argparse.ArgumentParser(); ap.add_argument("--base", default="http://127.0.0.1:8090"); ap.add_argument("--out")
a = ap.parse_args()
model = sb.get_json(a.base + "/health").get("model") or ""
res = []
for i, p in enumerate(P):
    r = sb.post_json(a.base + "/v1/chat/completions", {"model": model, "messages": [{"role": "user", "content": p}],
                     "max_tokens": 300, "temperature": 0, "reasoning_effort": "none"}, 600)
    t = r["choices"][0]["message"]["content"]
    h = hashlib.sha256(t.encode()).hexdigest()[:16]
    print(f"greedy {i}: {h} {r.get('usage', {}).get('completion_tokens')} tokens: {t[:70]!r}")
    res.append({"prompt": p, "text": t, "sha": h})
if a.out: json.dump(res, open(a.out, "w"), indent=1)
