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
and 4-token MTP draft setting. It uses a 32,768-token prompt chunk, starts the GPU
image reader with the first picture and stops it after 120 s without one,
and disables route tail skipping and
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

The image reader is on demand (`"elastic": true` in the vision section,
`"vram_elastic": true`, `--vram-elastic-hold-mib 2816`). Without a picture its
1.7 GB of VRAM holds about 640 more experts (9,100 slots instead of 8,460). A
picture shrinks the expert cache by 2,600 MiB first (about 840 slots, 50 ms),
then the reader starts in about 1 s; 120 s after the last picture it stops and
the cache grows back. The experts the shrink takes out of VRAM keep a copy in
2.75 GiB of page-locked RAM set aside at start (`--vram-elastic-hold-mib`), so
nothing is read from the SSD. This needs `STRATA_EXCHANGE_ROTATE=1`.

`"STRATA_AVX512_EXPERTS": "0"` keeps the AVX-512 expert kernels from upstream
#5243 off. On this Ryzen 7 7800X3D they decoded no faster (results README,
2026-11-05). Set it to `"1"` on a Zen 5 CPU and measure again.

`"STRATA_SELECT_TWO_PASS": "1"` reads very long prompts about 1% faster with the
same selected cells. `"short_answer_room": true` and
`"reasoning_loop_recovery": "wrap"` only act when a thinking reply would end with
no answer. `STRATA_POOL_FUSED`, `STRATA_IQ4_W4A8` and `--kv k16v8` are built in
and off: they measured no faster here, or slower with no recall gain (results
README, 2026-11-05).

The token embedding is read in BF16 from
`/home/spark/Apps/MODELS/token-embd-bf16-uncensored.gguf` (`--embd-gguf`) instead
of the GGUF's IQ4_XS copy: perplexity 4.100 -> 4.053 on the quality set, speed
unchanged, 1212 MiB of host RAM instead of 322 MiB (results README). The file is
Qwen's BF16 table with the abliteration's refusal direction removed
(`tools/embd_bf16_ablit.py`); remove the `--embd-gguf` entry from `args` to go back.

Reasoning effort defaults to `xhigh` (the model's own default): line 17 of
`/home/spark/Apps/MODELS/qwen38-fixed-chat-template.jinja` sets
`_default_reasoning_effort`; the `medium` original is kept beside it as
`qwen38-fixed-chat-template.medium-default.jinja.bak`. A request can still ask
for `reasoning_effort` low or medium. The server's answer room (on by default)
closes the thinking early enough to leave a quarter of a request's `max_tokens`
for the answer, and `"reasoning_budget_tokens": 49152` caps the thinking of a
reply at about 49K tokens (5-6 minutes), only against runaway thinking; a
thinking loop is wrapped up earlier by `reasoning_loop_recovery`. Checked
2026-11-06: a 1,200-token cap thought 688 tokens and answered in full.

The Qwen Swift Code launchers (`~/.local/bin/qwen-swift-code`, `-yolo`) send
`reasoning_effort: "high"` (the template's xhigh) and `max_tokens: 65536`
from `~/.config/qwen-swift/qwen-home/settings.json`, so each reply may think up
to 49,152 tokens and keeps 16,384 for its answer. Typing `<|think_medium|>` in
a message switches to medium from that message on, `<|think_xhigh|>` switches
back, `<|think_low|>` and `<|think_off|>` also work; the template removes the
tag before the model sees it.

## The desktop app (`strata-app`)

`~/.local/bin/strata-app` (a copy is `personal/strata-app`, and the app menu's "Strata (desktop app)"
starts it) runs the window and runtime of the 0.2.11 AppImage, unpacked in
`~/Applications/strata-runtime/squashfs-root`, with this fork's app code: its `usr/lib/Strata/host`
folder links `dist` and `server` to `apps/host`. After a change to the UI run `npm run build` in
`apps/host`, then restart the app; a change to `apps/host/server` only needs the restart. The agent
harness is the AppImage's own (`STRATA_HARNESS_DIR`). The app's data is in `~/.strata/data`.

It is pinned to this machine's model (`apps/host/server/pinned-model.mjs`): `STRATA_PIN_BASE_URL`
names the server, `STRATA_PIN_SERVICE` the unit it starts when the server does not answer (about a
minute), and every chat runs on it; the model pickers and the Models screens are hidden.

The sidebar has three profiles, Chat, Code and RP (`apps/host/server/profiles.mjs`), configured in
Settings -> Profiles: system message, reasoning effort (Medium or Extra High), thinking budget,
sampling, output cap, tools on or off, approval mode, which tool groups and connected tools, and which
skills. A profile's tools and skills are left out of what the model is offered and refused by the
approval gate if it asks for them anyway. `STRATA_PROFILE_DEBUG=<file>` logs, per agent request, the
tools before and after the profile and the sampling sent.
