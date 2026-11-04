# RTX 5090 OrcaRouter IQ4_XS profile

This profile runs the local Qwen3.8-Flash-Next-Uncensored-IQ4_XS model on
Spark's RTX 5090, Ryzen 7 7800X3D and 96 GB RAM. It uses the model, tokenizer,
MTP draft layer and image encoder already installed under `/home/spark/Apps`.
The engine is built from this checkout for CUDA `sm_120`:

```sh
cmake -S . -B build-5090-iq4xs -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DSTRATA_ENABLE_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 -DSTRATA_BUILD_TESTS=OFF
cmake --build build-5090-iq4xs --target strata -j8
```

`rtx5090-orca-iq4xs.json` keeps the old model files, 260,000-token context,
INT8 KV, 32,768 resident KV cells, 64 GiB expert RAM budget, sampling defaults
and 4-token MTP draft setting. It uses a 16,384-token prompt chunk, keeps the
image reader on the GPU from startup, and disables route tail skipping and
short-prompt CPU expert sharing. Both disabled defaults can change answers;
they were absent from the old 0.1.39 engine. The learned expert profile is
reused and saved across restarts.

The user service copy is `qwen-orca-iq4xs.service`. The installed unit is at
`~/.config/systemd/user/qwen-orca-iq4xs.service` and serves on `127.0.0.1:8082`.
After changing the installed unit, run `systemctl --user daemon-reload` and
`systemctl --user restart qwen-orca-iq4xs.service`.

The measured comparison and raw API benchmark records are in
[`bench/results/2026-11-03-spark-5090-iq4xs`](../bench/results/2026-11-03-spark-5090-iq4xs/README.md).
