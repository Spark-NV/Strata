# Spark's RTX 5090, OrcaRouter IQ4_XS

Measured 2026-11-03 on Linux with an RTX 5090 (32,607 MiB VRAM), Ryzen 7
7800X3D (8 cores), 93 GiB usable RAM, NVIDIA driver 615.78.08, CUDA 13.4 and
the same local Qwen3.8-Flash-Next-Uncensored-IQ4_XS GGUF shards, pack, tokenizer,
MTP layer and image encoder. The old server used engine 0.1.39; the replacement
is engine 0.1.56 built from commit `ffa80d73` for `sm_120`. Both used a 260,000
token context, INT8 KV and a 64 GiB expert RAM budget.

The external `/home/spark/Apps/Strata-Bench/strata_benchmark.py` sent one warmup
and three measured requests per case to the local server. It used temperature
zero and no reasoning. The GPU was otherwise idle. Values are medians from the
server's timing records, in tokens per second. The raw reports contain the
actual token counts, cache statistics, settings and answer previews.

| Case | Old 0.1.39 | Fork 0.1.56 | Change |
| --- | ---: | ---: | ---: |
| Decode | 94.6 | 143.3 | +51.5% |
| Prompt 1K | 998.3 | 1,016.8 | +1.9% |
| Prompt 8K | 3,128.1 | 4,713.7 | +50.7% |
| Prompt 32K | 4,493.6 | 7,318.6 | +62.9% |
| Vision prompt | 409.6 | 359.0 | -12.4% |

The first committed profile used a 16,384-token prompt chunk and measured
6,618.3 tok/s at 32K. A 32,768-token chunk measured 7,418.8 tok/s in a
temporary, same-build run with the same answer-preserving switches. The final
installed profile measured 7,318.6 tok/s at 32K, 10.6% above the installed
16K profile. It needs about 50 GiB of pinned expert RAM and left about 22 GiB
available after the run. The final run above is the measurement of the profile
actually installed.

All three vision requests answered `red` in both main runs. All 1K, 8K and 32K
prompt requests answered `BENCHMARK-ACK`. The final server's image encoder was
confirmed running with `--gpu`; route tail skipping and CPU expert sharing were
disabled. This is a speed and smoke check, not a full quality evaluation or a
full-context stress test. The decode case stopped after a median of 103 output
tokens on the old server and 108 on the new server, despite a 256-token cap.

- [Old raw report](baseline-old-0139.json)
- [First 16K installed report](20261103-210634-fork-final-5090-iq4xs.json)
- [Temporary 32K report](20261103-211118-fork-prefill-32768-quality-safe.json)
- [Final 32K installed report](20261103-211344-fork-final-32768.json)
- [Final short report](20261103-211344-fork-final-32768.md)
