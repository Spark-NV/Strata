# Strata API benchmark

- Label: `embedding-boundary-fix-5090-iq4xs`
- UTC: 2026-11-04T05:31:49+00:00
- Server model: `orcarouter-qwen3.8-flash-next-uncensored-iq4_xs`
- Engine: `0.1.56`
- GPU: NVIDIA GeForce RTX 5090
- Repetitions: 3 (warm-up excluded)

| Test | Prompt tok/s | Decode tok/s | Prompt tokens | Output tokens | Cache hit | PCIe share | Draft acceptance | Check |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| decode_256 | 167.5 | 154.6 | 58.0 | 108.0 | 0.982 | 0.005 | 0.433 | — |
| vision_red_rectangle | 356.5 | 36.6 | 238.0 | 2.0 | 0.791 | 0.114 | 1.0 | pass |
| prefill_1k | 1036.0 | 120.8 | 1044.0 | 5.0 | 0.911 | 0.029 | 1.0 | — |
| prefill_8k | 4804.4 | 116.0 | 8389.0 | 5.0 | 0.971 | 0.002 | 0.75 | — |
| prefill_32k | 7423.4 | 159.7 | 32130.0 | 5.0 | 0.981 | 0.002 | 0.75 | — |

Notes: prompt/decode rates come from Strata's own request timing records. Each prefill prompt is unique, so cache reuse should normally be zero. Compare only runs with the same script version, repetition count, prompt sizes, sampling settings, model, and an otherwise idle GPU.
