# Strata API benchmark

- Label: `tuned-policy-repeat`
- UTC: 2026-11-04T07:50:25+00:00
- Server model: `orcarouter-qwen3.8-flash-next-uncensored-iq4_xs`
- Engine: `0.1.56`
- GPU: NVIDIA GeForce RTX 5090
- Repetitions: 3 (warm-up excluded)

| Test | Prompt tok/s | Decode tok/s | Prompt tokens | Output tokens | Cache hit | PCIe share | Draft acceptance | Check |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| decode_256 | 200.7 | 131.7 | 58.0 | 121.0 | 0.931 | 0.015 | 0.636 | — |
| vision_red_rectangle | 442.5 | 41.2 | 238.0 | 2.0 | 0.728 | 0.144 | 1.0 | pass |
| prefill_1k | 1202.3 | 96.5 | 1044.0 | 5.0 | 0.781 | 0.095 | 1.0 | — |
| prefill_8k | 5391.0 | 110.4 | 8389.0 | 5.0 | 0.869 | 0.057 | 1.0 | — |
| prefill_32k | 7510.3 | 132.3 | 32130.0 | 5.0 | 0.909 | 0.039 | 1.0 | — |

Notes: prompt/decode rates come from Strata's own request timing records. Each prefill prompt is unique, so cache reuse should normally be zero. Compare only runs with the same script version, repetition count, prompt sizes, sampling settings, model, and an otherwise idle GPU.
