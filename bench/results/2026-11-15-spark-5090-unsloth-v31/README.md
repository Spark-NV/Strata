# RTX 5090: the switch to Unsloth V3.1 UD-IQ4_XS, and ideas from Basalt

**Measured on:** RTX 5090 (575 W, driver 620.70), Ryzen 7 7800X3D, 93 GB DDR5, CachyOS 7.3.4, engine 0.1.56 of this fork,
2026-11-14/15. Speed probes run with the profile's sampling (Qwen's recommended temperature 1.0, top_p 0.95, top_k 20):
`probe.py` (story and code, 256 tokens), `probe2.py` (16 mixed topics, total tok/s over prompts 3-16), `probe3.py`
(the same, seeded). A fresh server per arm (`ab.py`). Run-to-run spread of the mixed probe: about ±5%.

## The model

`Qwen3.8-Flash-Next-Unsloth_V3.1_UD-IQ4_XS.gguf` (one 119 GB file) against the old OrcaRouter Uncensored IQ4_XS:

| Part | Old | New |
|---|---|---|
| Routed experts | 61 GiB: IQ4_XS gate/up, IQ4_NL down | 56 GiB: gate/up IQ3_XXS (28 layers), IQ4_XS (17), IQ2_S (3); down Q5_0 (33), IQ4_NL (13), Q2_0 (2) |
| Attention, GDN, shared expert | IQ4_XS / Q5_K | Q6_K / Q8_0 |
| PLE n-gram table | IQ4_NL, 26.8 GiB | Q8_0, 50.7 GiB, read from the SSD |

Pack: `packs/unsloth-v31-iq4_xs` (`tools/iq_pack.py --compat-bf16`). The token embedding of this file is Qwen's official
table plus quantization noise (`tools/embd_bf16_ablit.py`: 0.05% of the difference on one direction, noise 0.039%), so the
BF16 embedding is the official table as shipped: `MODELS/token-embd-bf16-official.gguf` (bytes of shard 130 of
`Qwen/Qwen3.8-Flash-Next`, sha256 of the table `62288a3fca91d357...`). The MTP draft (`mtp/rt`) came from the official
checkpoint and is reused.

**Quality**, `tools/quant_quality.py` (4,995 positions, GPU experts fixed, no adaptation), same engine and day:
perplexity old 4.115, **new 3.988** (`qq-compare.txt`). The two models agree on the top token 85.9% of the time.

## Profile changes (`personal/rtx5090-unsloth-v31-iq4xs.json`)

| Change | Why | Measured |
|---|---|---|
| `--ple-io direct` | the Q8_0 table does not fit the file cache beside the 50 GiB RAM copy; mapped reads churned it | prompt 52K tokens 6,130-6,260 -> 6,340-6,530 tok/s; PLE host time 1.0-1.5 s -> 0 per prompt; CPU pool 29 -> 37 GB/s |
| Learned expert profile for this model | the old model's profile fits badly: with the tier frozen the CPU served 8.4 experts a layer-window | hit rate 65.7% at start -> 94% after 45 prompts x 3 (`learn_profile.py`, the probes' prompts left out); frozen-tier decode 61-82 -> 90-93 tok/s |
| `STRATA_AVX512_EXPERTS=1` | 28 layers' gate/up are IQ3_XXS, CPU-bound on Zen 4; the AVX-512 rows are bit-exact (comments in `native_expert.cpp`) | mixed 132.3 / 130.3 / 135.3 vs 129.9 / 130.9 / 129.0 (+2.1%); frozen tier +1.6% |
| `--vram-reserve-mib 1152` | 1024 failed to start (verify arena 114 MiB short); 1408 left 1,061 MiB free | 9,682 expert slots instead of 9,236; 817 MiB free with everything loaded |

## Result

| | Old model, old settings | New model, tuned |
|---|---:|---:|
| Mixed decode (16 topics) | 137.2 (one run) | 132.6 (mean of 3; 130.3-135.3) |
| Decode window | 14.4 ms, 2.06 tokens | 13.2-14.3 ms, 2.05-2.1 tokens |
| Story / code | 189 / 198 | 177-183 / 187-214 |
| Prompt 8K / 52K tokens | ~5,960 / 7,180-7,500 | 5,240-5,580 / 6,740-7,075 |
| Perplexity | 4.115 | 3.988 |

Decode is even within the noise (each window is as fast or faster); prompt reads are 6-10% slower, because the dense
layers are Q6_K / Q8_0 and the IQ3_XXS experts cost more to unpack; quality is better.

## Tried and not kept

| Idea | Source | Result |
|---|---|---|
| Cumulative draft rule (`STRATA_DRAFT_CUM`, ported, opt-in) | Basalt `draft_cum.hpp` | sampled mixed 117.1 (spec 6), 105.4 (spec 8), 126.9 (threshold 0.55, spec 4) vs base 122-132: longer windows add CPU experts here (per-layer host 5.5 -> 7.3-8.6 ms) |
| Next-layer L2 prefetch while waiting for the CPU (`STRATA_L2_NEXT`, new, opt-in) | Basalt's lazy L2 prefetch | whole layer (80.6 MiB): 67 vs 90 tok/s, GPU time per window doubled; first 16 MiB (`STRATA_L2_NEXT_MIB=16`): 92.5 vs 92.0 |
| Two-stage Q6_K head | Basalt | not ported: Basalt's own figures give KLD +0.0022 for it; its exact form needs a Q8_0 head |
| `STRATA_SPEC_COST=1` | this fork | sampled mixed 118.1 at spec 6 (greedy 129.6-132.2, before the switch to sampled probes) |
| `STRATA_SPEC_PROB=1` | this fork (Basalt 0.4 has the same idea) | not run: its exact form needs `--adapt-swaps 0` (DETAILS.md) |
| `STRATA_SPEC_COUPLED=1`, with `STRATA_SPEC_GUMBEL=1` | this fork | 116.9 and 132.7 against base 122-132: no gain beyond the spread |
| `--pool-tasks 96` | Basalt (12 tasks a thread) | 121.3 vs 122.4-122.9 |
| 14 pool workers on the SMT siblings | - | 116.4 vs 122.4-122.9 |
| `STRATA_MMQ_DIRECT=1` | this fork | does not engage here; prompt times the same |

The greedy batches (`r1`, `b2`) were run before Spark asked for sampled probes only; they are kept as files and not used
above.

## Round 2 (level-1 abliterated file)

**Measured on:** the same PC, 2026-11-15, the file `Qwen3.8-Flash-Next-Unsloth_V3.1_UD-IQ4_XS-abliterated-L1.gguf`
(huihui-ai's Unsloth patch at `--ablate-experts 1`), sampled probes as above. Mixed decode is "total tok/s over prompts
3-16" of `probe2.py`; the runs are grouped by the start's PCIe probe reading (see the first change).

### Kept

| Change | What | Measured |
|---|---|---|
| PCIe probe waits for the link (`generate.cpp`, `probe_pcie_h2d_gbps`) | An idle RTX 5090 keeps its link at a low speed until traffic raises it. The probe's four bursts often all read 7.3 GB/s, and that start kept a PCIe share of 0.10 instead of 0.55 for the whole session. Now a round under 20 GB/s is followed by up to 7 more (about 1 s at most), and the best reading counts. `STRATA_PCIE_PROBE_ROUNDS=1` keeps one round. | 30 of about 90 starts on this day read 7-21 GB/s, the live service's last two starts too. Mixed decode with the old engine: slow-probe starts 122.4 / 123.5, good-probe starts 129.0-138.9 (mean 134.0, n=4). With the fix the probe read 57.6-57.8 GB/s in all 6 starts, 5 of them after a slow first round. |
| IQ3_XXS grid decode with AVX-512 VBMI (`iq_avx512.cpp`, `Fmt<118>`) | On Zen 4 (no fast gather) the 64-value groups were built from 16 table loads and inserts. Now a whole 256-value block goes through `vpermi2b` / `vpermb`, and its 32 sign indices through one `vpmultishiftqb`. The same bytes, so the same sums. `STRATA_NO_IQ3_VBMI=1` turns it off. | Bit-exact: `iq3_vbmi_parity` (1-8 tokens, gate/up and plain rows, 40 random trials) gives the same hash both ways; `quant_quality.py` with every expert on the CPU gives a byte-identical file with the old and the new engine. Gate/up `pool_layer_bench` (IQ3_XXS/Q5_0): 0.064 -> 0.040 ms a layer from cache, 0.066 -> 0.049 from RAM. All-CPU quality run 20.1 -> 18.3 s a segment. Normal decode: no measurable change (there the pool waits on RAM, not on the decode). |
| Expert RAM on 2 MiB pages where free (`STRATA_PIN_GUARD=2` + `STRATA_COMPLEMENT_THP=2`, `expert_source.cpp`) | `cudaHostAlloc` gives the 48.7 GiB complement 4 KiB pages. Mode 2 allocates it 2 MiB-aligned (THP "always" fills free blocks, no compaction) and page-locks it with one `cudaHostRegister`. Only the page size changes. | 20-30 GiB on huge pages, pinned in 27-33 s (34-37 s before). Per CPU expert entry, gate/up 1.24-1.29 vs 1.25-1.30 ms (last batch) and 1.29-1.33 vs 1.44-1.54 ms (first batch, mode 1); mixed 139.2-141.1 vs 139.4-141.0. A floor, not a measured gain. Mode 1 (`MADV_HUGEPAGE`) got a few GiB more but its start grew to 290 s as the RAM fragmented; `MADV_COLLAPSE` failed here (no free blocks). |

**Result:** mixed decode 139-141 tok/s on every start (5 of 5), where the old engine gave 122-139 depending on the probe.
Quality (`qq-compare.txt` method, against the old reference): level 1 perplexity 4.010, top-1 85.37% (level 0: 3.988,
85.89%); the old and the new engine give the same file.

### Tried and not kept

| Idea | Result |
|---|---|
| `STRATA_HC_Q8=1` (on this file the GGUF's own Q8_0 hyper-connection weights, exact) | mixed 127.8 / 134.1 / 133.4 against 129.0-138.9: no faster, GPU-reach wait higher |
| `--mtp-q4 all` (4-bit draft layer and head) | 133.7 vs 140.5: drafts accepted 0.691 vs 0.719 |
| `STRATA_GRAPH_PRIO=1` | 139.8 vs 140.5 |
| `STRATA_DEQUANT_SIDE=1` (prompt) | 13K / 52K tokens: 5,897 / 7,032 vs 5,851 / 7,031 tok/s |
| `STRATA_PF_FUSED_NT=256 STRATA_PF_BATCH=256` (prompt) | 5,758 / 6,943 vs 5,793 / 6,973 |
