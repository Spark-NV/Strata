"""A/B: python ab.py NAME exe=/path [env K=V ...] [args='--x y'] [drop='--flag'] -- runs server on 8090, probe, timing lines."""
import json, os, re, subprocess, sys, time, urllib.request, statistics as S
ROOT="/home/spark/Apps/Strata"; SP=os.path.dirname(os.path.abspath(__file__))
name=sys.argv[1]; kv=dict(a.split("=",1) for a in sys.argv[2:])
c=json.load(open(kv.pop("cfg",f"{ROOT}/personal/rtx5090-orca-iq4xs.json")))   # cfg=: another config (the A/B's baseline)
c["port"]=8090; log=f"{SP}/ab-{name}.log"; c["log"]=log
c.pop("expert_profile_save",None); c.pop("expert_profile_save_every",None)
if "exe" in kv: c["exe"]=kv.pop("exe")
args=c["args"]
if "drop" in kv:
    for d in kv.pop("drop").split(";"):
        i=args.index(d.split()[0]); n=len(d.split()); del args[i:i+n]
if "args" in kv: args+=kv.pop("args").split()
if "set" in kv:   # set='--prefill 16384;--spec 5'
    for d in kv.pop("set").split(";"):
        k,v=d.split(); args[args.index(k)+1]=v
perf=kv.pop("perf","0")=="1"; mixed=kv.pop("mixed","0")=="1"; n=int(kv.pop("n","8")); pre=kv.pop("prefill","0")=="1"; lng=kv.pop("long","0")=="1"; novis=kv.pop("novision","0")=="1"
if novis: c.pop("vision",None); args.remove("--vision")
c["env"]={**c.get("env",{}), "STRATA_DECODE_TIMING":"1", **kv}
cfg=f"{SP}/ab-{name}.json"; json.dump(c,open(cfg,"w"),indent=1)
if os.path.exists(log): os.remove(log)
p=subprocess.Popen([f"{ROOT}/.venv/bin/python","-m","serve.server","--engine","strata","--config",cfg,"--port","8090"],cwd=ROOT,stdout=open(f"{SP}/ab-{name}.out","w"),stderr=subprocess.STDOUT)
t=time.time()
while True:
    try:
        urllib.request.urlopen("http://127.0.0.1:8090/health",timeout=2); break
    except Exception:
        if p.poll() is not None: print("server died"); sys.exit(1)
        time.sleep(2)
print(f"[{name}] up in {time.time()-t:.0f}s", flush=True)
cmd=[sys.executable,f"{SP}/probe.py","--base","http://127.0.0.1:8090","--n",str(n),"--out",f"{SP}/ab-{name}-probe.json"]
if pre: cmd.append("--prefill")
if lng: cmd.append("--long")
if perf:
    pr=subprocess.Popen(cmd); time.sleep(25)
    pid=[x for x in subprocess.check_output(["pgrep","-f","--","--serve --pack"]).decode().split()][-1]
    env={**os.environ,"LD_LIBRARY_PATH":os.path.expanduser("~/.local/opt/perf/usr/lib")}
    subprocess.run([os.path.expanduser("~/.local/opt/perf/usr/bin/perf"),"record","-e","cycles:u","-F","4000","-p",pid,"-o",f"{SP}/perf-{name}.data","--","sleep","8"],env=env)
    pr.wait()
else:
    subprocess.run(cmd)
if mixed:
    subprocess.run([sys.executable,f"{SP}/probe2.py","--base","http://127.0.0.1:8090","--out",f"{SP}/ab-{name}-mixed.json"])
p.send_signal(2)
try: p.wait(60)
except Exception: p.kill(); p.wait()
time.sleep(3)
alll=[l for l in open(log, errors="replace") if "decode timing:" in l]
lines=[l for l in alll if "CPU pool" not in l]; pl=[l for l in alll if "CPU pool" in l][2:]
def num(pat,l):
    m=re.search(pat,l); return float(m.group(1)) if m else None
keys={"ms/window":r"([\d.]+) ms/window","tok/win":r"([\d.]+) tokens/window","verify":r"verify ([\d.]+)","reach":r"GPU-reach wait ([\d.]+)","layerhost":r"per-layer host ([\d.]+)","stage":r"\+ stage ([\d.]+)","commit":r"commit/emit ([\d.]+)","draft":r"draft ([\d.]+)","ajoin":r"adapt join ([\d.]+)","other":r"other ([\d.]+)","cpuexp":r"CPU experts ([\d.]+)"}
rows=lines[2:]
print(f"[{name}] decode timing medians over {len(rows)} requests:", {k:round(S.median([num(v,l) for l in rows if num(v,l) is not None]),3) for k,v in keys.items()})
if pl:
    pk={"gu":r"gate/up ([\d.]+)","q":r"quant ([\d.]+)","down":r"down ([\d.]+)","GBs":r"([\d.]+) GB/s"}
    print(f"[{name}] pool:", {k:round(S.median([num(v,l) for l in pl if num(v,l) is not None]),3) for k,v in pk.items()})
