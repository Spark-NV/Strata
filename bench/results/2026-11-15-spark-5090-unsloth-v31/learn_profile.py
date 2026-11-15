"""Teach a server's adaptive tier the new model's experts: every prompt of bench/profile_corpus.json (45 chat, code,
maths, writing and six-language prompts; none of the speed probes' prompts), `--rounds` times, 400 tokens each, with
the profile's sampling.  Run it against a server started with expert_profile_save; the profile is written on QUIT."""
import argparse, json, sys, time
sys.path.insert(0, "/home/spark/Apps/Strata/bench/api")
import strata_benchmark as sb

ap = argparse.ArgumentParser(); ap.add_argument("--base", default="http://127.0.0.1:8090"); ap.add_argument("--rounds", type=int, default=2)
a = ap.parse_args()
corpus = json.load(open("/home/spark/Apps/Strata/bench/profile_corpus.json"))
model = sb.get_json(a.base + "/health").get("model") or ""
t0 = time.monotonic(); n = 0
for r in range(a.rounds):
    for i, c in enumerate(corpus):
        resp = sb.post_json(a.base + "/v1/chat/completions", {"model": model, "messages": [{"role": "user", "content": c["p"]}],
                            "max_tokens": 400, "reasoning_effort": "none"}, 900)
        n += resp.get("usage", {}).get("completion_tokens") or 0
    print(f"round {r + 1}: {n} tokens so far, {time.monotonic() - t0:.0f} s", flush=True)
