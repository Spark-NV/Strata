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

The Monitor page reads the pinned server's own `/metrics` every 2 s while it is open (`/api/pinned/metrics`),
so speed, prompt reading, state and requests show for agent work too (agent requests reach the server
through the Harness, past the host's own counters).

It is pinned to this machine's model (`apps/host/server/pinned-model.mjs`): `STRATA_PIN_BASE_URL`
names the server, `STRATA_PIN_SERVICE` the unit it starts when the server does not answer (about a
minute), and every chat runs on it; the model pickers and the Models screens are hidden.

The app also gives the model's memory back when it is not wanted (`apps/host/server/model-release.mjs`).
It checks every 3 s and stops the unit:

- **When a game starts.** That is a Steam launch (the `reaper SteamLaunch AppId=…` process, Proton or
  native), a Lutris game, a Proton game run through umu (Heroic), or gamescope. It stops at once, even in
  the middle of a turn. Measured on 2026-11-07 with a fake Steam launch: the unit was stopped and the
  GPU was back to about 1 GB 10 s after the launch.
- **After 30 minutes with no model work.** That means nothing generating or queued on the server (so
  requests from other apps count), no agent turn running, and no chat sent.

When it is released, the chat's model badge reads "Asleep · …". Typing a message, sending one, or
clicking the badge starts it again; it took 58 s on 2026-11-07. A game already running doesn't release
the model again. So a chat started mid-game keeps the model until it has been idle for 30 minutes, and
the app doesn't start the model when it opens while a game runs. Settings, in the launcher's
environment:

- `STRATA_PIN_IDLE_MIN` sets the idle minutes (30; 0 turns the idle stop off).
- `STRATA_PIN_GAME_RELEASE=0` turns the game stop off.
- `STRATA_PIN_GAMES=name,name` adds process names (as in `/proc/<pid>/comm`) that count as games.

The watch runs only while the app runs.

The Monitor's **Model time** card (`apps/host/src/components/ModelTime.tsx`, `GET /api/pinned/activity`) shows:

- whether the model is running and for how long, how long it has been idle, and a bar toward the 30 minute stop;
- while it is stopped, for how long and why: idle, a game (named), images, or outside the app;
- today's and the last 7 days' time running, stopped while idle, for games, for images, and for other reasons.

The log is `~/.strata/data/model-activity.json` and keeps 8 days. Time is only recorded while the app runs:
a stop the app did not see counts as "other", and the time the model takes to load counts with the stop
before it.

### Image chats

The sidebar's **Image** group makes pictures with Qwen-Image-2.1 (`apps/host/server/image-model.mjs`,
`src/lib/image-chat.ts`, `src/components/ImageChat.tsx`). Each message is a description; the reply shows
a live preview and the step while it draws, then the images. The chat's size, number of images, steps,
guidance, seed and "leave out" text are under the composer and kept with the chat.

The model runs in stable-diffusion.cpp's `sd-server`, which keeps it loaded between images. It and the
text model never share the GPU (together they need about 54 GB):

- Writing in an Image chat stops the text model, then loads the image model (about 24 GB of VRAM).
- Writing in any other chat unloads the image model, then starts the text model.
- The image model is also unloaded after 30 minutes idle and when a game starts; the text model then
  stays stopped until you write.
- The toolbar badge has **Unload** while it is loaded.

The launcher sets it up: `STRATA_IMAGE_SERVER` (`engine-image/sd-server`), `STRATA_IMAGE_DIFFUSION`,
`STRATA_IMAGE_LLM`, `STRATA_IMAGE_VAE`, and optionally `STRATA_IMAGE_STEPS` and `STRATA_IMAGE_CFG` for a
new chat's defaults (40 and 4, for the regular, non-Turbo model). Without them there are no Image chats.
The images are kept in `~/.strata/data/generated-images`.

Measured on the RTX 5090, F16 denoiser, Q8_0 text encoder, 40 steps, guidance 4: a 1024x1024 image takes
about 32 s (0.8 s a step), and about 41 s for the first image after loading. Swapping takes about 10 s to
stop the text model and a few seconds to load the image model; going back, the text model takes about a
minute to start.

**Editing pictures.** Attach up to 4 pictures to a message (the Pictures button, drop or paste, or **Edit**
under an image the chat made) and say what to change. The prompt names them `<image1>`, `<image2>`
(the model's own labels). The page scales them first: picture 1 to about 1 MP, the others to about
0.6 MP; with a full-size second picture the model ignored the prompt in a test here. An edit draws at
picture 1's shape with the edit settings, 25 steps and guidance 1 (guidance 4 burnt the colours of an
edit). It needs the text encoder's vision file, `STRATA_IMAGE_VISION`
(`mmproj-Qwen3VL-8B-Instruct-F16.gguf` from `Qwen/Qwen3-VL-8B-Instruct-GGUF`, 1.2 GB).

**LoRAs.** `STRATA_IMAGE_LORA_DIR` is a folder of LoRAs made for Qwen-Image-2.1 (LoRAs for the older
Qwen-Image 2509/2512, Flux or Wan do not work on it). Each can have a `<file>.strata.json` note: title,
description, kind (`style` or `edit`), strength, triggers (trigger words shown on its card; a click adds
one to the prompt), prefix (words added to the front of the prompt), prompt (offered by **Use its prompt**),
pictures (what each `<imageN>` should be), steps and cfg, and source. The Image chat's **LoRAs** list turns
them on per chat. While a LoRA is on, its steps and guidance are used instead of the chat's (with several,
the most steps and the lowest guidance); its card can change them for the chat, and **Save as its default**
writes strength, steps and guidance back into the note. The folder's `AGENTS.md` tells an assistant how to
set up a new LoRA and write its note.
In `~/Apps/MODELS/loras/qwen-image-2.1`, each checked against Hugging Face's SHA-256:

| LoRA | For | From |
| --- | --- | --- |
| Anime style (FUSAL), 0.7, 25 steps, guidance 1 | any image | MicksHF/Qwen-Image-2.1-Anime-Fusal |
| Anime character consistency, 0.7 | edits | WarmBloodAban/Qwen-Image-2.1-LoRAs |
| Anything to real person, 0.7 | edits | WarmBloodAban/Qwen-Image-2.1-LoRAs |
| Edit consistency (nothing moves), 1.0 | edits | ausboss/Qwen-Image-2.1-Consistency-LoRA |
| Outfit swap, 1.0 | edits: person, outfit | ausboss/Qwen-Image-2.1-Outfit-Swap-Consistency-LoRA |
| Head swap, and Head swap keeping expression (BFS v1.1), 1.0 | edits: scene, head | Alissonerdx/BFS-Best-Face-Swap |
| Whole person swap (BFS body), 1.0 | edits: scene, person | Alissonerdx/BFS-Best-Face-Swap |

Measured here (RTX 5090, 1024x1024): the anime LoRA at 25 steps and guidance 1 about 22 s; an edit with
one picture about 20 s; a two-picture edit about 21 s.

`engine-image/sd-server` is built from the stable-diffusion.cpp commit `tools/image/qimage.py` pins:

    .venv/bin/python tools/image/install.py --backend cuda --arch 120 --build-only
    cmake --build build-image-cuda --target sd-server -j && cp build-image-cuda/bin/sd-server engine-image/

Closing the window hides it to the tray (Settings -> General -> Minimise to tray, on; the file is
`~/.local/share/strata/shell-prefs.json`). On Linux the tray item is a StatusNotifier: click it, then
Open Strata or Quit Strata. Starting Strata from the menu also brings the hidden window back. Upstream
builds the Linux window without a tray, so `~/Applications/strata-runtime/squashfs-root/usr/bin/strata-desktop`
is this fork's own build. Build it with
`TAURI_CONFIG='{"bundle":{"resources":null}}' cargo build --release` in `apps/desktop/src-tauri` (about
1 minute once the crates are built). The AppImage's own binary is kept next to it as
`strata-desktop.0.2.11-notray.bak`.

The sidebar has four profiles, Chat, Code, Vibe and RP (`apps/host/server/profiles.mjs`), configured in
Settings -> Profiles: system message, reasoning effort (Medium or Extra High), thinking budget,
sampling, output cap, tools on or off, approval mode, which tool groups and connected tools, and which
skills. A profile's tools and skills are left out of what the model is offered and refused by the
approval gate if it asks for them anyway. `STRATA_PROFILE_DEBUG=<file>` logs, per agent request, the
tools before and after the profile and the sampling sent.

Each profile also has (Settings -> Profiles): memory switches (use memory, save to memory), web search
without the once-per-chat question, agents and slash commands. Defaults: Chat and Code use and save
memory and search without asking; RP has none of it.

- **Memory** (`apps/host/server/memory.mjs`, list in Settings -> Memory, file `~/.strata/data/memory.json`):
  a profile with memory on gets the list in its system prompt; with saving on the agent has
  `remember` / `recall` / `forget` (`apps/host/server/agent/memory-mcp.mjs`), which never ask.
- **Agents**: named helpers the model starts with the subagent tool as `@name task`. The forwarding
  endpoint sees the `@name` in the helper's first message and gives it that agent's instructions and
  only its tools (groups like `find` or single tools like `read`). Code starts with `@explorer`
  (read-only), `@reviewer` and `@tester`; Chat with `@researcher`.
- **Commands**: `/name text` sends the command's prompt with `$ARGUMENTS` replaced (client side, the
  chat shows what was typed). Code: `/review /test /commit /fix /explain`; Chat: `/summarize /explain
  /proofread /compare`. The built-in `/plan /goal /research /compact /loop` still work.

### Roleplay

RP chats are SillyTavern-style (`apps/host/server/rp/`): the RP group's + opens the Roleplay library
(characters, personas, lorebooks; files in `~/.strata/data/rp/`). Cards import from Tavern/SillyTavern
PNG or JSON (V1, V2, V3) and export as PNG (V2 and V3 chunks) or JSON; lorebooks import and export as
SillyTavern World Info JSON. Ticking several characters starts a group chat.

The host builds the prompt (`prompt.mjs`) in the order of Settings -> Roleplay (main prompt, World Info,
persona, description, personality, scenario, examples, chat, post-history), with macros, World Info
(keys, secondary-key logic, regex, constant, chance, delay, recursion, inclusion groups, budget, all
positions), the author's note, character's note and persona at their depths, names in group chats,
stop strings at the person's (and other members') names, and the newest messages that fit the window.
Example dialogues give way first. Sampling, thinking and the output cap come from the RP profile.

The RP message box has Spoken, Action, Thought and Narration buttons (Alt+S, Alt+A, Alt+T, Alt+N): pick
one and type, or select text and press one. The box and the chat show only the style (speech in an
accent colour, actions in grey italics, thoughts in violet italics with a dotted underline); what is
sent is "speech", *action*, ((thought)), and the Text format piece of the prompt (Settings -> Roleplay)
tells the model to read and write it that way. Editing a message uses the same box.

In a chat: swipes (‹ n/m ›, past the last version writes a new one), edit, delete, hide from the model,
branch, Continue, Impersonate (writes your next message into the box), Next speaker and click-a-member
in groups, the author's note, the chat's lorebooks, and the prompt inspector (search icon). Commands:
`/continue /impersonate /swipe /talk name`. Not done: SillyTavern's sticky and cooldown timers (kept on
import and export but not applied), and the extensions (image generation, TTS, vector storage).

### Code projects

A new Code chat's start screen has a Recent projects tab (`apps/host/server/projects.mjs`, list in
`~/.strata/data/recent-projects.json`): every folder a chat was pointed at, newest first, with its git
branch and which agent instruction files it has. Clicking one makes it the chat's folder. Per project:
Edit / New AGENTS.md opens it in Kate (`STRATA_EDITOR` overrides; a missing file is created from a
short template with the sections a good one has), and Write / Improve with the assistant sends this
chat a prepared message: read the project, ask at most 6 questions about what the code cannot tell
(as answer cards), write a short AGENTS.md, and add one-line CLAUDE.md / QWEN.md / GEMINI.md pointers
for the tools you say you use. The agent harness loads AGENTS.md into every Code chat in that folder.

### Vibe

A Vibe chat is Code with a Head AI that owns the engineering: you say what you want to exist, it
asks what matters, writes a brief, and after you approve it builds, checks and hands the work over
(`apps/host/server/agent/plugins/strata-vibe.mjs`, `vibe-state.mjs`, the gate's `vibeDecision`).
Pick a project folder first (an empty one for something new). The bar above the chat shows the stage
(Planning, Building, Handed over), the milestones, the last check and the branch, with Brief /
Decisions / Status buttons that open the project book. When the Head waits for you, the bar shows a pulsing
"Needs your answer" button (and the dock above the message box becomes one line pointing to it): it opens
the answer panel on the right (`src/components/VibeInbox.tsx`) with the Head's latest message formatted,
its question cards with room to read, and for the brief the whole BRIEF.md with Approve and build, Deny,
or Request changes in your own words (sent to the Head as its next message).

To watch the Head and its helpers talk, open **Subagents** at the top of the chat and press **View
conversation** on a helper (in any chat with helpers, not only Vibe). The right panel shows the Head's
task and messages, what the helper says, its messages back and its report, with one short line per
command it ran; file edits and tool output are left out. **Commands** and **Thinking** switch those
lines on or off. A working helper's conversation updates every two seconds and follows the end while
you are at the bottom. It only reads the helper's saved session file
(`server/agent/helper-transcript.mjs`, `GET /api/chat/helper/conversation`), so watching never changes
the helper's or the Head's work. Outside the app, `python3 tools/vibe_conversations.py <folder>` writes
the same conversations for a whole project as one HTML page.

A tool call the model writes as text (it guessed a name such as `read_file`, or reached for a tool the
helper does not have) used to end a helper mid-work. The agent's model proxy now makes it a real call
(`server/agent/text-tool-calls.mjs`): a common other name for an offered tool calls that tool, with its
parameter names matched; any other name gets "unknown tool" back, so the helper carries on in the same
turn and nothing it is not allowed can run. Every helper keeps `send_message` (the Harness tells each one to
report with it), and a helper without the skill tool is no longer shown the skill list.

- **Stages, enforced by the gate, not the prompt.** Planning: nothing in the project can change
  (edits and changing commands are refused); the Head reads, researches and asks 3-5 questions per
  round with ask cards. It writes the brief with `vibe_brief` and asks for approval with `vibe_start`
  (one card). Building: everything runs without a permission prompt (installing, `sudo -n pacman`,
  any tool); only sending the work off this computer (git push, publishing, creating a remote
  repository) asks. Builders and checkers keep throwaway files in /tmp; `scratchpad/`, `tmp/` and local
  database files (`*.db`, `*.sqlite`) are ignored from the start. A small task skips the approval card. Besides the Head's own questions, that
  is the only card. The Mode menu is replaced by "Vibe".
- **Save points.** Git is set up without asking (it works inside a parent repository when there is
  one, and `.gitignore` gets the usual caches plus any secrets, generated folders and files over 50 MB
  it found). Your own uncommitted changes are committed apart first ("Your work before Vibe"). The work
  runs on a `vibe/<name>` branch; the app commits before every helper task, before checks and at every
  milestone. `vibe_finish` merges the checked work into the branch it started from by itself (the
  work branch is kept, so it can be undone), and the Head then presents it.
- **Done means checked.** A milestone closes (`vibe_milestone_done`) only when the brief's check
  commands passed on the latest saved version and an `@checker` helper that changed no files in that
  milestone recorded a passing `vibe_review` for the same version. A new dependency, more than 15
  deleted files or a protected file in a milestone needs a recorded decision. A "small" task that
  grows past 8 files must become medium and be approved.
- **Loops.** 3 failed checks in a row block changes until the Head records a different approach
  (`vibe_decide` kind rethink); 5 block them until you answer. One builder at a time: a helper cannot
  change files while another helper that changed files is still working.
- **The project book** (`.strata/project/` in the project, committed): `book.json` plus BRIEF.md,
  DECISIONS.md, STATUS.md, written only by the vibe tools. Requirements are marked confirmed, assumed
  or open; decisions say who decided (you or Head), why and what was rejected; lessons list approaches
  that failed. A short summary of it goes in front of every message, so it survives summaries and
  restarts. The run state (stage, last check, reviews, who changed files) is outside the project, in
  `~/.strata/data/vibe/projects/<key>.json`.
- **Helpers**: `@builder` (one task, tests, report), `@checker` (independent review, changes nothing),
  `@researcher`, `@explorer`; editable in Settings -> Profiles -> Vibe like the other profiles.
- Not done yet: sandboxing builders to the project folder at the OS level, hiding git credentials
  from them (pushing is only caught by its command words), and a backup of the save points outside
  the project.


### Remote access

The whole app over HTTPS on port 8443, on the home network and from outside through Cloudflare
(`https://sprinkler.sparknv.win:8443`), behind one key in `~/.config/strata-remote/remote.json`. Turned on by
`STRATA_REMOTE_CONFIG` in the launcher. Setup, the API for apps and what was tested: [REMOTE.md](REMOTE.md).
