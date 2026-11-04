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

## Draft cut-off, swap pace and the CPU-row copy (2026-11-04)

Same probe and A/B runner, plus [`session2/probe2.py`](session2/probe2.py): 16
different prompts (science, Rust, SQL, a story, history, a recipe, a poem...),
256 tokens each, the first two dropped, total tokens over total decode time.
It shows what a topic change costs: the default config decodes the repeated
story and code prompts at about 175 tok/s and the 16 new topics at about 110,
because the VRAM cache holds the wrong experts for a new topic and the CPU
computes more of them.

Kept:

- **`--spec-min-p 0.7`** (was 0.5). Drafting stops sooner, windows are
  shorter and cheaper (15.8 to 14.1-15.0 ms). Story / code: 0.3 gave
  165.1 / 168.8, 0.5 gave 178.2 / 170.9 and 179.1 / 174.0, 0.7 gave
  184.3 / 175.8 and 177.0 / 181.2, 0.8 gave 172.8 / 176.9. A verify window
  decides every token, so the cut-off changes speed only.
- **`--adapt-every 8`** (was 4). Each exchange of the adaptive tier copies an
  expert both ways over PCIe and through RAM, about 21 per window by
  default, and that traffic slows the CPU pool. Two alternating rounds,
  medians of story / code / 16 topics:

  | Adaptive tier | Story | Code | 16 topics |
  | --- | ---: | ---: | ---: |
  | default (every 4 windows, min gain 1.5) | 174.1, 174.5 | 171.9, 182.5 | 108.1, 111.3 |
  | `--adapt-every 8` | 179.3, 178.7 | 186.4, 201.3 | 106.4, 106.6 |
  | `--adapt-every 8 --adapt-min-gain 3` | 184.0, 185.9 | 196.0, 195.2 | 103.9, 105.0 |

  Fewer swaps help when a topic continues and cost a little on the first
  answer after a change. `--adapt-every 8` is the middle choice. Turning the
  tier off (`--adapt-every 0`) gave 65.5 / 86.0, and `--adapt-min-gain 6`
  gave 136.7 / 166.1, so the tier itself is essential.
- **The CPU rows' copy.** `copy_rows_from_mapped` reads the CPU pool's rows
  over PCIe, one block a row. Each thread now issues all its loads before
  its stores. A launch with 1-3 CPU rows took 2.4-3.9 us instead of
  4.7-5.7 us (the microbenchmark below); the bytes are the same. A kernel
  test with random hit sets and widths 4-8192 passed.

Tried and not kept (same probe, decode tok/s story / code unless noted):

- `--spec 3` 169.9 / 169.0 and `--spec 5` 170.8 / 164.4 against `--spec 4`.
- Six switches the docs call exact (`STRATA_EXPDEC`, `STRATA_HC_UPMIX`,
  `STRATA_B6_MMVQ_ROWS`, `STRATA_GRAPH_PRIO`, `STRATA_QSA_ROWS`,
  `STRATA_DF_PDL`): three alternating rounds, 176 / 177.5 without and
  176 / 179 with. The texts matched. No gain worth a default.
- The prompt-side switches (`STRATA_PF_FUSED_NT=256`, `STRATA_PF_BATCH=256`,
  `STRATA_PLE_COMPACT`, `STRATA_PLE_COPY_STREAM`, `STRATA_DEQUANT_SIDE`,
  `STRATA_PREFILL_ROUTED_STREAM`): two slow outliers (2,649 and 5,470
  prompt tok/s), no clear gain.
- `STRATA_HC_REQ8=1` (int8 hyper-connection weights, 206 more cache slots):
  149.6 / 164.9 / 98.9, slower, because the stream-split read does not
  take int8 weights.
- A GPU look-ahead written for this test: the verify window ran the next
  layer's router on the current layer's MoE input and the host copied the
  predicted experts into Foresight swap slots. It cut the CPU experts per
  layer-window from 1.65 to 1.17 but copied about 100 experts a window at
  about 40% precision. That RAM traffic slowed the CPU pool from 45 to
  31 GB/s and the result was 152.6 / 156.1. The code was removed.
- Vision off frees about 650 cache slots and gave 184.9 / 187.2 against
  178 / 171. The on-demand encoder cannot give that VRAM back in the pinned
  RAM mode (`VRAM: not with the resident low-RAM mode`), so the encoder
  stays loaded.

The pool now also prints its gate/up, quantization and down time per window
with `STRATA_DECODE_TIMING=1`: 3.1 + 1.6 ms at 42-46 GB/s of expert bytes,
against about 58 GB/s that 1 to 8 threads of this CPU read from RAM.

The installed service then gave 175.7 decode tok/s (an 80-token answer),
1,064.5 at 1K, 4,667.0 at 8K, 7,128.6 at 32K and 379.6 vision prompt
tok/s, and 104.6 tok/s on the 16 topics. A second benchmark right after it
gave 131.7, 1,202.3, 5,391.0, 7,510.3 and 442.5: its decode case ran after
the first run's 32K prompts had moved the cache (hit rate 0.931 against
0.985). The session's first benchmark repeat showed the same drop with the
old settings, so the benchmark's decode number depends on what ran before
it; the fixed-length probes start each server fresh.

- [Installed report](20261104-004907-tuned-policy-5090-iq4xs.json)
- [Repeat](20261104-005025-tuned-policy-repeat.json)

The CPU-row copy microbenchmark (RTX 5090, 2,000 back-to-back launches of
rows of 2,560 floats, the GPU's rows given as hits):

| Window tokens | CPU rows | Before (us) | After (us) |
| ---: | ---: | ---: | ---: |
| 1 | 1 | 4.71 | 2.42 |
| 4 | 1 | 4.92 | 2.88 |
| 4 | 3 | 5.14 | 3.48 |
| 8 | 3 | 5.71 | 3.88 |
| 8 | 8 | 5.81 | 5.42 |

## Exchange buffer rotation (2026-11-04)

An exchange of the adaptive tier copied the expert leaving VRAM into a
staging buffer and then, with a CPU `memcpy`, into the RAM place of the
expert coming in: about 10.6 MB of RAM traffic per swap. With the pinned,
mapped RAM copy of this config, `STRATA_EXCHANGE_ROTATE=1` hands buffer
ownership over instead (0.24 GiB of spare page-locked buffers, no host
copy; the upstream A/B found the same output tokens). Swaps became cheap
enough that adapting more often pays:

| Rotation, `--adapt-every` | Story | Code | 16 topics |
| --- | ---: | ---: | ---: |
| 8 | 177.0 | 184.9 | 107.2 |
| 4 | 174.3 | 184.8 | 117.5 |
| 2 | 185.3, 186.4 | 192.7, 188.2 | 120.0, 128.6 |
| 1 | 176.3 | 195.8 | 128.7 |
| 2, `--adapt-swaps 192` | 184.8 | 188.2 | 129.7 |
| 2, `--adapt-min-gain 1.2` | 186.6 | 197.4 | 123.7 |

The config now sets rotation and `--adapt-every 2`. Against the settings at
the start of the day (no rotation, every 4 windows, min-p 0.5: 174 / 177 /
110) that is about +6% story, +8% code and +13% on new topics. Two more
rounds checked the draft cut-off under rotation: min-p 0.7 gave 183.9 /
191.6 / 122.6 and 184.1 / 199.5 / 126.2, min-p 0.5 gave 183.0 / 183.0 /
120.3 and 178.1 / 187.8 / 121.3. The benchmark's word-list prompt answers
with 6 to 106 tokens, so its decode rate varies with the answer length;
it was 144-150 tok/s with either cut-off.

The installed service then gave 169.4 decode tok/s on the benchmark's
word-list case (121 tokens), 1,064.5 at 1K, 4,895.0 at 8K, 7,233.1 at 32K,
361.9 vision prompt tok/s and 126.7 tok/s on the 16 topics. All vision
answers were `red` and all prompt answers `BENCHMARK-ACK`.

- [Installed report](20261104-010950-rotate-adapt2-5090-iq4xs.json)

## The hyper-connection up read in 8-column blocks (2026-11-04)

In the profiled verify windows the two hyper-connection reads per layer
(`gr_down_v3` + `gr_up_v3`) took about 19% of the GPU time. The up read ran as
160 blocks of 16 columns: fewer blocks than the RTX 5090's 170 SMs. New bit
512 of `STRATA_GR_V3_PF` runs it as 320 blocks of 8 columns. Each output has
the same rows, lanes and order, so the results are bitwise the old read's.
It is now on by default on compute capability 12.0 (mask 133 | 512).

`gr_v3_screen` (cold weights, 16 weight sets, median of 5 rounds; RTX 5090;
[`session2/gr_v3_screen_cols8.txt`](session2/gr_v3_screen_cols8.txt)): `0 differing`, and

| Window tokens | Up read before (us) | After (us) | Whole read before (us) | After (us) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 8.58 | 7.04 | 15.85 | 13.77 |
| 2 | 9.38 | 7.20 | 16.72 | 14.36 |
| 4 | 12.00 | 8.61 | 21.73 | 18.60 |
| 8 | 14.37 | 11.17 | 29.21 | 26.20 |

Four columns per block (640 blocks) was faster only at 1 and 3 tokens, and
the column-half split of the down read (`S = 2`) was slower at every window
size; neither is kept. In two alternating pairs of server starts the GPU
part of a window (the host waiting for the GPU) fell from 5.94 / 6.01 to
5.77 / 5.66 ms. Decode tok/s, story / code / 16 topics: before 183.4 /
197.0 / 126.2 and 179.9 / 193.8 / 125.2; after 188.8 / 203.2 / 125.6 and
184.8 / 179.9 / 123.4 (the second code run had one 145 tok/s request).

## Where the second session ended (2026-11-04)

The installed service (engine `32d6e770`, the config in `personal/`) gave
180.2 decode tok/s on the benchmark's word-list case (89 tokens), 1,043.7
at 1K, 4,758.4 at 8K, 7,067.6 at 32K and 372.0 vision prompt tok/s; then
129.8 tok/s over the 16 new topics and 191.2 tok/s on the story probe.
Prompt speeds across this session's API runs averaged about 1,090 / 4,940 /
7,280 tok/s at 1K / 8K / 32K, close to the 1,036 / 4,804 / 7,423 the
previous section measured; the decode changes do not touch the prompt path.

| Decode, tok/s | Start of session | End |
| --- | ---: | ---: |
| Story, 256 tokens (median) | 162-166 | 184-191 |
| Code, 256 tokens (median) | 159-167 | 180-203 |
| 16 new topics (total) | about 108-111 | 124-130 |

Measured and left for later: the vision encoder's 1.7 GB of VRAM would be
about 650 more cache slots (+4% story, +9% code with vision off) but the
encoder can only give it back if the expert cache can shrink in the pinned
RAM mode; the hyper-connection down read (about 10 us at 4 tokens against
a 3.6 us bandwidth floor) needs a thread layout whose sums of squares add
in a different order; a smaller draft vocabulary would cut the draft head
(133 of each 322 us draft step) at the cost of never drafting rare tokens.
