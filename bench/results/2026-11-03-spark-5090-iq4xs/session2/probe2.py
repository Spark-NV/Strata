"""Mixed decode probe: 16 distinct prompts across topics, 256 tokens each; total tok/s over prompts 3..16."""
import argparse, json, statistics, sys
sys.path.insert(0, "/home/spark/Apps/Strata/bench/api")
import strata_benchmark as sb
P = [
 "Explain how a refrigerator moves heat from inside to outside, in detail.",
 "Write a Rust function that parses an INI file into a HashMap, with error handling and tests.",
 "Tell a long bedtime story about a lighthouse keeper and a talking seagull.",
 "Summarize the causes and consequences of the French Revolution for a high-school student.",
 "Give a detailed weekly meal plan for a vegetarian athlete, with recipes.",
 "Write a SQL schema and example queries for a library management system.",
 "Explain the proof that there are infinitely many primes, then generalize to primes of the form 4k+3.",
 "Draft a polite but firm email to a landlord about a broken heater that has not been fixed for two weeks.",
 "Write a bash script that backs up a directory with rotation and logs, and explain each part.",
 "Describe the life cycle of a star from nebula to its possible endings.",
 "Write a dialogue between two detectives arguing about who committed a museum theft.",
 "Explain how transformers and attention work in machine learning, with equations.",
 "Write a JavaScript React component for a sortable, filterable table with hooks.",
 "Give practical advice for starting a vegetable garden in a small backyard.",
 "Compose a sonnet-like poem about winter in a mountain village, then explain its imagery.",
 "Explain the differences between TCP and UDP and when to use each, with examples.",
]
ap = argparse.ArgumentParser(); ap.add_argument("--base", default="http://127.0.0.1:8090"); ap.add_argument("--out"); ap.add_argument("--tag", default="m")
a = ap.parse_args()
model = sb.get_json(a.base + "/health").get("model") or ""
rows = [sb.request_case(a.base, model, {"prompt": f"[{a.tag}{i}] " + p, "max_tokens": 256}, 600) for i, p in enumerate(P)]
m = rows[2:]
tok = sum(r["output_tokens"] for r in m); ms = sum(r["decode_ms"] for r in m)
acc = sum(r["drafts_accepted"] or 0 for r in m) / max(1, sum(r["drafts_offered"] or 0 for r in m))
print(f"mixed: total decode {tok / ms * 1000:.1f} tok/s over {len(m)} prompts ({tok} tokens), median {statistics.median([r['decode_tok_s'] for r in m]):.1f}, acc {acc:.3f}")
if a.out: json.dump(rows, open(a.out, "w"), indent=1)
