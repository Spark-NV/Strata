# Strata API benchmark

- Label: `single-fork-install-new-vision`
- UTC: 2026-11-04T04:45:48+00:00
- Server model: `orcarouter-qwen3.8-flash-next-uncensored-iq4_xs`
- Engine: `0.1.56`
- GPU: NVIDIA GeForce RTX 5090
- Repetitions: 3 (warm-up excluded)

| Test | Prompt tok/s | Decode tok/s | Prompt tokens | Output tokens | Cache hit | PCIe share | Draft acceptance | Check |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| decode_256 | 186.7 | 141.0 | 58.0 | 83.0 | 0.98 | 0.002 | 0.379 | — |
| vision_red_rectangle | 376.4 | 38.5 | 238.0 | 2.0 | 0.795 | 0.113 | 1.0 | pass |
| prefill_1k | 1061.9 | 97.7 | 1044.0 | 5.0 | 0.923 | 0.025 | 1.0 | — |
| prefill_8k | 4933.0 | 125.6 | 8389.0 | 5.0 | 0.974 | 0.002 | 0.75 | — |
| prefill_32k | 7498.8 | 173.0 | 32130.0 | 5.0 | 0.975 | 0.003 | 0.75 | — |

Notes: prompt/decode rates come from Strata's own request timing records. Each prefill prompt is unique, so cache reuse should normally be zero. Compare only runs with the same script version, repetition count, prompt sizes, sampling settings, model, and an otherwise idle GPU.
