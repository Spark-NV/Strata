# Strata API benchmark

- Label: `installed-fork-replacement`
- UTC: 2026-11-04T04:33:49+00:00
- Server model: `orcarouter-qwen3.8-flash-next-uncensored-iq4_xs`
- Engine: `0.1.56`
- GPU: NVIDIA GeForce RTX 5090
- Repetitions: 3 (warm-up excluded)

| Test | Prompt tok/s | Decode tok/s | Prompt tokens | Output tokens | Cache hit | PCIe share | Draft acceptance | Check |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| decode_256 | 158.3 | 138.6 | 58.0 | 89.0 | 0.981 | 0.006 | 0.386 | — |
| vision_red_rectangle | 352.2 | 38.1 | 238.0 | 2.0 | 0.826 | 0.13 | 1.0 | pass |
| prefill_1k | 1025.6 | 83.5 | 1044.0 | 5.0 | 0.938 | 0.036 | 1.0 | — |
| prefill_8k | 4850.8 | 119.6 | 8389.0 | 5.0 | 0.978 | 0.007 | 0.75 | — |
| prefill_32k | 7230.9 | 166.7 | 32130.0 | 5.0 | 0.987 | 0.005 | 1.0 | — |

Notes: prompt/decode rates come from Strata's own request timing records. Each prefill prompt is unique, so cache reuse should normally be zero. Compare only runs with the same script version, repetition count, prompt sizes, sampling settings, model, and an otherwise idle GPU.
