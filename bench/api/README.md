# Strata API benchmark

`strata_benchmark.py` is a repeatable API benchmark for a local Strata server.
It measures whichever server is running, so the same script can compare the
current custom IQ4_XS build with a future build.

It measures Strata's own request timings rather than only client wall-clock
time:

- prompt/prefill tokens per second at roughly 1K, 8K, and 32K prompt sizes;
- decode tokens per second from a 256-token output request;
- a deterministic GPU-vision image request, including a simple red-image
  correctness check;
- actual prompt and output token counts;
- expert-cache hit rate, PCIe share, RAM/file expert reads, and speculative
  draft acceptance when the server reports them;
- hardware and engine/config metadata needed to interpret a comparison.

## Baseline command

Run as `spark` while only the target Strata server is active and the GPU is
otherwise idle:

```bash
cd /home/spark/Apps/Strata
python bench/api/strata_benchmark.py \
  --label current-iq4xs \
  --strata-dir . \
  --config personal/rtx5090-orca-iq4xs.json
```

It writes a JSON record and a concise Markdown table under
`/home/spark/benchmark-results/strata-api/`. The default is three measured
runs per test after one unrecorded warm-up. For a shorter check during active
development, add `--quick`; do not compare a quick result with a full result.

For a candidate server running on another local port, use its API URL and a
distinct label:

```bash
python bench/api/strata_benchmark.py \
  --base-url http://127.0.0.1:8084 \
  --label candidate-strata-0.2.10 \
  --strata-dir /path/to/candidate \
  --config /path/to/candidate/config.json
```

Use identical model files, test options, GPU conditions, and repetition count
when deciding whether a change is faster. The unique prefill prompts avoid
conversation/KV reuse, which makes prompt throughput comparable between runs.
The case names are target sizes; use the recorded actual token count in the
report when evaluating a result. Every measured repetition changes its prompt
from the beginning, so the server cannot report a misleading cached-prefill
result as a full-prefill benchmark.
