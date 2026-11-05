"""Long-context recall: python needle.py NAME EXE [kv=int8|k16v8] [ENV=V ...] -- a fresh server on 8090 per run.

Each trial hides five facts ("The code of the <colour> door is NNNN.") at spread depths of a ~120K-token text of plain
English sentences, then asks for all five, greedy and without thinking.  Prints the codes recalled per trial and in all.
"""
import json, os, random, re, subprocess, sys, time, urllib.request
ROOT = "/home/spark/Apps/Strata"
SP = os.path.dirname(os.path.abspath(__file__))
name, exe = sys.argv[1], sys.argv[2]
kv = dict(a.split("=", 1) for a in sys.argv[3:])
kvfmt = kv.pop("kv", "int8")
trials = int(kv.pop("trials", "6"))
words_n = int(kv.pop("words", "90000"))
c = json.load(open(f"{ROOT}/personal/rtx5090-orca-iq4xs.json"))
c["port"] = 8090; c["exe"] = exe; c["log"] = f"{SP}/needle-{name}.log"
c.pop("expert_profile_save", None); c.pop("expert_profile_save_every", None)
c["args"][c["args"].index("--kv") + 1] = kvfmt
c["env"] = {**c.get("env", {}), **kv}
cfg = f"{SP}/needle-{name}.json"; json.dump(c, open(cfg, "w"), indent=1)
if os.path.exists(c["log"]): os.remove(c["log"])
p = subprocess.Popen([f"{ROOT}/.venv/bin/python", "-m", "serve.server", "--engine", "strata", "--config", cfg, "--port", "8090"],
                     cwd=ROOT, stdout=open(f"{SP}/needle-{name}.out", "w"), stderr=subprocess.STDOUT)
while True:
    try:
        urllib.request.urlopen("http://127.0.0.1:8090/health", timeout=2); break
    except Exception:
        if p.poll() is not None: print("server died"); sys.exit(1)
        time.sleep(2)

SUBJ = "farmer teacher river engineer child storm merchant doctor painter sailor village city garden council".split()
VERB = "watched built crossed repaired carried opened described visited followed counted measured remembered".split()
OBJ = ("the old bridge|a quiet market|the northern road|a broken clock|the long winter|a small boat|the stone wall|"
       "a careful letter|the river bank|a wooden table|the morning train|a narrow street").split("|")
TAIL = ("before noon|after the rain|near the hills|without a word|for many years|in the evening|with great care|"
        "at the harbor|during the festival|under the trees").split("|")
COLOURS = ["red", "blue", "green", "yellow", "white"]

total = got_all = 0
rows = []
for t in range(trials):
    rng = random.Random(1000 + t)
    codes = {col: rng.randint(1000, 9999) for col in COLOURS}
    sentences = []
    while sum(len(s.split()) for s in sentences) < words_n:
        sentences.append(f"The {rng.choice(SUBJ)} {rng.choice(VERB)} {rng.choice(OBJ)} {rng.choice(TAIL)}.")
    depths = [0.08, 0.28, 0.5, 0.7, 0.92]
    order = COLOURS[:]
    rng.shuffle(order)
    for d, col in sorted(zip(depths, order), reverse=True):
        sentences.insert(int(d * len(sentences)), f"The code of the {col} door is {codes[col]}.")
    text = " ".join(sentences)
    q = ("Below is a long text. Somewhere in it are the codes of five doors.\n\n" + text +
         "\n\nWhat are the codes of the red, blue, green, yellow and white doors? Answer with one line per door, "
         "in the form `colour: code`.")
    body = {"model": "x", "messages": [{"role": "user", "content": q}], "max_tokens": 120, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request("http://127.0.0.1:8090/v1/chat/completions", json.dumps(body).encode(),
                                 {"content-type": "application/json"})
    t0 = time.time()
    r = json.load(urllib.request.urlopen(req, timeout=1200))
    ans = r["choices"][0]["message"].get("content") or ""
    hit = sum(1 for col in COLOURS if re.search(rf"{col}\D{{0,12}}{codes[col]}", ans, re.I))
    total += hit; got_all += hit == 5
    rows.append({"trial": t, "prompt_tokens": r.get("usage", {}).get("prompt_tokens"), "hit": hit, "answer": ans,
                 "codes": codes, "s": round(time.time() - t0, 1)})
    print(f"[{name}] trial {t}: {hit}/5 ({rows[-1]['prompt_tokens']} prompt tokens, {rows[-1]['s']} s)", flush=True)
json.dump(rows, open(f"{SP}/needle-{name}-result.json", "w"), indent=1)
print(f"[{name}] kv {kvfmt}: {total}/{5 * trials} codes, {got_all}/{trials} trials all five", flush=True)
p.send_signal(2)
try: p.wait(60)
except Exception: p.kill(); p.wait()
time.sleep(3)
