# RTX 5090 OrcaRouter IQ4_XS profile

This profile runs the local Qwen3.8-Flash-Next-Uncensored-IQ4_XS model on
Spark's RTX 5090, Ryzen 7 7800X3D and 96 GB RAM. It uses the model, tokenizer,
MTP draft layer and image encoder already installed under `/home/spark/Apps`.
The engine is built from this checkout for CUDA `sm_120`:

```sh
cmake -S . -B build-5090 -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DSTRATA_ENABLE_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 -DSTRATA_BUILD_TESTS=OFF
cmake --build build-5090 --target strata -j16
install -m 755 build-5090/strata engine/strata
```

The GPU image reader is built from the fork's `tools/vision` source with the
pinned llama.cpp revision in `setup.py`, CUDA architecture `120`, and
`STRATA_PORTABLE=OFF` for this CPU. Its installed path is
`engine/strata-vision`.

The active installation and fork checkout are both `/home/spark/Apps/Strata`.
Its `engine/strata` is the CUDA `sm_120` build. The model
pack, MTP files, learned profile and virtual environment are in this one
installation.

`rtx5090-orca-iq4xs.json` keeps the old model files, 260,000-token context,
INT8 KV, 32,768 resident KV cells, 64 GiB expert RAM budget, sampling defaults
and 4-token MTP draft setting. It uses a 32,768-token prompt chunk, keeps the
image reader on the GPU from startup, and disables route tail skipping and
short-prompt CPU expert sharing. Both disabled defaults can change answers;
they were absent from the old 0.1.39 engine. The learned expert profile is
reused and saved across restarts.

`STRATA_ADAPT_OVERLAP=1` and `STRATA_ADAPT_OVERLAP_RESIDENT=1` let the
resident RAM tier copy experts while the next decode window runs. Each layer
waits for its own copy before use. This improved the fixed-length decode probe
on this PC; the paired measurements are linked below.

The user service copy is `qwen-orca-iq4xs.service`. The installed unit is at
`~/.config/systemd/user/qwen-orca-iq4xs.service` and serves on `127.0.0.1:8082`.
After changing the installed unit, run `systemctl --user daemon-reload` and
`systemctl --user restart qwen-orca-iq4xs.service`.

The measured comparison and raw API benchmark records are in
[`bench/results/2026-11-03-spark-5090-iq4xs`](../bench/results/2026-11-03-spark-5090-iq4xs/README.md).

The engine turns off the router look-ahead by itself here: with every expert
in VRAM or the pinned RAM copy it only warms file pages that are never read,
and it slowed decode windows from 15.8 to 17.5 ms. On Linux the mapped PLE
table is advised `MADV_RANDOM` and the drafted tokens' rows are read ahead.
Both changes are measured in the results README below.

`--spec-min-p 0.7`, `--adapt-every 2` and `STRATA_EXCHANGE_ROTATE=1` were
chosen by fixed-length probes on this PC: shorter draft runs, and adaptive
swaps that hand pinned buffers over instead of copying each evicted expert
through RAM, so the cache can follow a new topic quickly without slowing the
CPU expert pool.
