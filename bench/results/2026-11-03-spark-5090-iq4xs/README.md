# Spark's RTX 5090, OrcaRouter IQ4_XS

Measured 2026-11-03 on Linux with an RTX 5090 (32,607 MiB VRAM), Ryzen 7
7800X3D (8 cores), 93 GiB usable RAM, NVIDIA driver 615.78.08, CUDA 13.4 and
the same local Qwen3.8-Flash-Next-Uncensored-IQ4_XS GGUF shards, pack, tokenizer,
MTP layer and image encoder. The old server used engine 0.1.39; the replacement
is engine 0.1.56 built from commit `ffa80d73` for `sm_120`. Both used a 260,000
token context, INT8 KV and a 64 GiB expert RAM budget.

The benchmark in [`bench/api/strata_benchmark.py`](../../api/strata_benchmark.py) sent one warmup
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
temporary, same-build run with the same answer-preserving switches. The 32K
profile measured 7,318.6 tok/s at 32K, 10.6% above the 16K profile. It needs
about 50 GiB of pinned expert RAM and left about 22 GiB available after the
run.

After copying the fork's runtime into `/home/spark/Apps/Strata` and pointing
the user service there, a fresh three-repeat benchmark measured 138.6 decode,
1,025.6 at 1K, 4,850.8 at 8K, 7,230.9 at 32K, and 352.2 vision prompt
tokens/s. The prompt results are close to the earlier run. The report records
the installed config hash and 260,000-token context; all answer checks passed.

The old source checkout and its image reader were then replaced with this
fork's checkout and a CUDA `sm_120` image reader built from the fork's pinned
llama.cpp revision. A new three-repeat run from the single installation
measured 141.0 decode, 1,061.9 at 1K, 4,933.0 at 8K, 7,498.8 at 32K, and
376.4 vision prompt tokens/s. The vision answer was `red` in all three runs.
These differences are from short runs and may include normal run-to-run noise.

## Resident expert swap overlap (2026-11-03)

With the same model, context and resident RAM mode, we tested
`STRATA_ADAPT_OVERLAP=1` and `STRATA_ADAPT_OVERLAP_RESIDENT=1`. The source says
a layer waits for its expert copies before using them. A fixed 256-token story
prompt gave a more stable decode length than the benchmark's word-list case.
After discarding the first six of 11 runs in each sequence, the median decode
rates were 174.5 tok/s with overlap off, 191.8 tok/s with it on after a fresh
restart (+9.9%), and 176.8 tok/s with it off again. A separate overlap start
measured 193.9 tok/s, and the installed overlap service measured 183.6 tok/s.
Every story request returned 256 tokens. One output preview varied once with
overlap off and once in each overlap sequence, so these runs do not show a
change unique to the switch. They do not prove full answer identity.

The full API benchmark with overlap on measured 148.5 decode tok/s, 976.8 at
1K, 4,847.2 at 8K, 7,304.1 at 32K, and 353.7 vision prompt tok/s. A repeat
measured 133.2 decode tok/s (the word-list answer ended at 59 tokens), 1,058.1
at 1K, 4,874.5 at 8K, 7,652.0 at 32K, and 392.9 vision prompt tok/s. All
vision and `BENCHMARK-ACK` checks passed. The prompt and vision rates varied
across these short runs; the overlap switch affects decode scheduling.

All three vision requests answered `red` in both main runs. All 1K, 8K and 32K
prompt requests answered `BENCHMARK-ACK`. The final server's image encoder was
confirmed running with `--gpu`; route tail skipping and CPU expert sharing were
disabled. This is a speed and smoke check, not a full quality evaluation or a
full-context stress test. The decode case stopped after a median of 103 output
tokens on the old server and 108 on the new server, despite a 256-token cap.

## Long prompt embedding boundary (2026-11-03)

A temporary 65,536-token prefill chunk failed on a fresh 76K-token prompt with
`iq_embed_rows: invalid argument`. The embedding kernel launched one CUDA grid
row per token and exceeded the 65,535-row grid limit. A regression test with
65,537 BF16 embedding rows reproduced that exact error before the change and
passed after splitting the launch into groups of at most 65,535 rows. The
existing short BF16 embedding test passed too.

The rebuilt engine answered a fresh 75,322-token prompt at 7,446.8 prompt
tok/s with the installed 32,768-token chunk. The temporary 65,536-token chunk
then answered a fresh 76,122-token prompt at 7,274.7 prompt tok/s, where it
previously failed. Both requests returned `BENCHMARK-ACK` with no reused KV.
The larger chunk reduced the GPU KV window from 32,768 to 4,096 tokens on this
card and showed no prompt speed gain in this check, so the installed profile
still uses 32,768. Both configurations kept the 260,000-token context.

The installed engine then ran the external benchmark with three measured runs
per case. Median rates were 154.6 decode tok/s, 1,036.0 at 1K, 4,804.4 at 8K,
7,423.4 at 32K, and 356.5 vision prompt tok/s. All three vision answers were
`red`; all nine prefill answers were `BENCHMARK-ACK`. The raw report records
zero reused tokens for every measured request.

- [Old raw report](baseline-old-0139.json)
- [First 16K installed report](20261103-210634-fork-final-5090-iq4xs.json)
- [Temporary 32K report](20261103-211118-fork-prefill-32768-quality-safe.json)
- [Final 32K installed report](20261103-211344-fork-final-32768.json)
- [Final short report](20261103-211344-fork-final-32768.md)
- [Replacement installation report](20261103-213349-installed-fork-replacement.json)
- [Replacement short report](20261103-213349-installed-fork-replacement.md)
- [Single fork installation report](20261103-214548-single-fork-install-new-vision.json)
- [Single fork installation short report](20261103-214548-single-fork-install-new-vision.md)
- [Overlap fixed-length decode runs](2026-11-03-adapt-overlap-fixed256.json)
- [Overlap temporary API report](20261103-215624-adapt-overlap-resident.json)
- [Installed overlap API report](20261103-220322-installed-adapt-overlap.json)
- [Installed overlap repeat](20261103-220417-installed-adapt-overlap-repeat.json)
- [Embedding boundary fix benchmark](20261103-223149-embedding-boundary-fix-5090-iq4xs.json)

## PLE reads and the file-tier look-ahead (2026-11-03, second session)

`STRATA_DECODE_TIMING=1` splits each decode window into its parts. A fixed
256-token probe ([`session2/probe.py`](session2/probe.py), a story and a
code prompt, eight runs each, the first two dropped) ran on a server
started per arm by [`session2/ab.py`](session2/ab.py). Same model, config
and 260,000-token context. A window took 17.4 ms on the installed engine.
About 6-7 ms of it was the CPU pool computing the experts the VRAM cache
missed (1.8 per layer and window), with the GPU waiting.

Two fixes, both for Linux with every expert in VRAM or pinned RAM:

- **PLE table reads.** On Linux the mapped PLE table (28.8 GB of random
  90-byte rows) had no `MADV_RANDOM`, so each row fault read ahead about
  128 KiB from the SATA SSD (142 us median per random 4 KiB read here).
  `prefetch_rows` did nothing on Linux. Now the table is `MADV_RANDOM` and
  the drafted tokens' rows get `MADV_WILLNEED` before the window. Host
  staging per window fell from 0.31 to 0.10 ms, the per-layer host time
  from 7.07 to 6.53 ms, and the window from 17.42 to 16.94 ms.
- **The look-ahead thread.** The router look-ahead predicts the next
  layer's experts on the CPU to warm the file tier's pages. Here no expert
  is read from the file, so the thread only took a core and memory
  bandwidth from the expert pool (6% of the sampled CPU time, as much as
  the IQ4_NL down kernel). It is now off when the pinned RAM copy holds
  every expert the GPU does not (`STRATA_LOOKAHEAD=1` keeps it). The window
  fell from 17.5 to 15.8 ms.

| Probe (median tok/s) | Before | PLE fix | PLE fix + look-ahead off |
| --- | ---: | ---: | ---: |
| Story, 256 tokens | 162.1 | 172.9 / 166.9 | 179.1 / 178.2 |
| Code, 256 tokens | 167.0 | 163.1 / 158.1 | 174.0 / 170.9 |

The two numbers per cell are two separate server starts. Every probe
request returned 256 tokens. The code answers matched the old engine's
8 of 8. The story answers matched 3 of 8. Two starts of the same engine
also matched only 2 to 4 of 8, because the GPU and the CPU round a missed
expert differently and the cache holds different experts on each start.
Prompt speed did not change (8K-word prompts 5,216-5,894 tok/s, 52K-token
prompts 7,353-7,603 tok/s, all `BENCHMARK-ACK`).

Tried and not kept: `--pcie-frac` 0.25 / 0.75 / 1.0 gave 18.0 / 17.8 /
19.3 ms windows against about 17 ms for the automatic share near 0.5. The
Foresight swap space (`STRATA_FS_SLOTS=4`, reserve raised by 512 MiB) gave
18.4 ms: its CPU predictor took 51 ms per window and had no prediction
for 84% of the layers.

The installed engine then ran the API benchmark: 182.9 decode tok/s
(108-121 output tokens), 1,054.7 at 1K, 4,961.6 at 8K, 7,470.9 at 32K
and 385.5 vision prompt tok/s. The same benchmark at the start of the
session gave 162.2, 1,117.2, 5,100.6, 7,258.2 and 402.4. All vision
answers were `red` and all prompt answers `BENCHMARK-ACK`.

- [Session start report](20261103-224850-baseline-session2.json)
- [Installed report](20261103-234036-ple-lookahead-5090-iq4xs.json)
- [Probe answers and window timings per arm](session2/)
