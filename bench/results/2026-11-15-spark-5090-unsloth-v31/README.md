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
| All of the expert RAM on 2 MiB pages (root: `sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory` before the start, `runc.sh`, `tc.out`) | 48.1-50.1 GiB of huge pages instead of about 30. Mixed 137.0 / 140.3 / 143.5 against 140.0 / 140.4 with 4 KiB pages (`STRATA_COMPLEMENT_THP=0`), interleaved on the same compacted RAM; CPU gate/up 1.97-2.32 vs 2.20-2.37 ms. No decode gain beyond the spread; kept anyway at Spark's choice, since it costs nothing (start 46 s, unchanged): `personal/system/` runs it before every start. |

## Round 3: Ryzen 9 9950X3D (same day)

**Measured on:** the same PC with the 7800X3D replaced by a Ryzen 9 9950X3D (16 cores, 2 chiplets: cores 0-7 with
96 MB L3, 8-15 with 32 MB, SMT siblings 16-31), G.SKILL F5-5200J4040A48G 2x48 GB at DDR5-5600 (timings on Auto:
40-40-40-83, tRFC 1065, tREFI 10892), the level-1 file and the live profile. Sampled probes as above.

The board's "X3D Turbo Mode" (Gigabyte) was on at first: it hides the second chiplet and SMT, and Linux saw 8 cores.

### RAM bandwidth (`tools/bw/bw`, 16 GiB of reads, threads pinned)

| Threads on | GB/s read |
|---|---|
| 1 core | 64.9 |
| cores 1-7 (V-Cache chiplet) | 60.1 |
| cores 8-15 (second chiplet) | 58.7 |
| cores 1-15 | 60.0 |
| all 32 threads | 60.0 |

The RAM is the limit at this speed and these timings, not the chiplet links: a second chiplet adds no bandwidth. Refresh
alone holds each rank about 10% of the time (tRFC 380 ns every 3.89 us).

### Decode, worker layouts (`run10.sh`, `t11.out`)

| Arm | Mixed tok/s |
|---|---|
| default (15 workers, both chiplets, host on core 0) | 140.0 (first start), 150.5 |
| `STRATA_POOL_CORES=1-15` | 150.1 |
| `STRATA_POOL_CORES=8-15` (second chiplet) | 151.7 |
| `STRATA_POOL_CORES=1-7` (V-Cache chiplet) | 145.7, 147.2 |
| `STRATA_POOL_CORES=1-15,17-31` (SMT) | 144.2 |
| the Zen 4-built engine | 148.2 |

On the 7800X3D the same probes gave 139-141. The gain is the faster cores: per-layer host time fell from about 4.3 to
3.3-3.8 ms a window, while the pool's read rate stayed at 48-51 GB/s. The engine's own PCIe share now starts at 0.35-0.40
(15 workers) instead of 0.55. The default is kept.

### Retried ideas (`run11.sh`, `t12.out`; baselines 147.6 / 150.2 / 143.8)

| Arm | Mixed tok/s |
|---|---|
| `--spec 5` / `--spec 6` | 148.7 / 148.8 |
| `--pool-tasks 96` | 145.6 |
| `STRATA_DRAFT_CUM=1 --spec 6` | 105.7 |
| `--pcie-frac 0.45` / `0.65` | 142.9 / 142.8 |
| Zen 4 kernel picks (`STRATA_AVX512_1T=0 STRATA_IQ4NL512=0`, `run13.sh`) | 146.1 / 145.8 against 139.8 / 143.3, CPU gate/up the same (2.03-2.08 vs 1.84-2.13 ms) |

None is faster beyond the spread.

### Short prompts: `STRATA_PREFILL_CPU_SHARE=auto` (`run12.sh`, `t13.out`), not kept

Prompt tok/s, 8 prompts each, two rounds: ~500 tokens 658 / 901 (GPU only) vs 889 / 905; ~1,150 tokens 1,346 / 1,412 vs
1,721 / 1,734 (+25%, about 0.2 s sooner to the first word). The logits after 20 prompts of 256-1000 tokens
(`quant_quality.py prompt --gpu-experts`, `qp-*`): GPU only twice gives KL 0; with the share, top-1 the same in 20/20 but
KL mean 0.011, max 0.079. It changes answers, so it stays off under the no-quality-loss rule.

### Exactness

- The Zen 5 rebuild (`-march=native` = znver5 for ggml-cpu) and the Zen 4-built engine give byte-identical quality runs on
  the 9950X3D (`qq-l1-old9950.tsv` = `qq-l1-zen5.tsv`), and the IQ3_XXS parity hash is unchanged (b944938c12bcbbb3).
  The rebuild is installed (`engine/strata`; the Zen 4 build is `engine/strata-2026-11-15-zen4-backup`). It is not faster.
- Against the 7800X3D reference (`qq-l1-new.tsv`) the 9950X3D differs: top-1 95.6%, KL 0.016, PPL 4.016 vs 4.010. Not
  the worker count (7 workers give the same file), partly the expert profile learned since (earlier profiles: KL 0.003
  between them on this CPU), and mostly the CPU kernels the engine picks on Zen 5 (`cpu_gather_fast`): with the Zen 4
  picks KL falls to 0.008 but PPL is 4.029. Every arm is within 4.010-4.029, so the default picks stay.
