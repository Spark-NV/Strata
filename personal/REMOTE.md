# Remote access

The whole Strata app, on the home network and from outside the house, behind one key. It is for this
PC only. The code is in `apps/host/server/remote-access.mjs`; the tests are `apps/host/tests/remote-access.test.mjs`.

## What it is

The host listens on **HTTPS port 8443** on every network card. Every request needs the key. Behind the key,
everything the app does works: chats, Code and Vibe chats on projects on this PC, Image chats, picture
editing, LoRAs, the Monitor. The only exception is **Quit Strata**, which stays on the PC.

The PC's own folder window cannot open from away. The remote listener marks every request it passes on
(`x-strata-remote: 1`, which a client cannot set or clear), and the routes that would open that window answer
`501 folder-chooser-unavailable` at once. The page then shows its own folder browser (`GET /api/folders` to look
inside a folder, `POST /api/folders {parent, name}` to make one; `apps/host/server/folder-browse.mjs`), and the
iPhone app uses the same two requests. A new folder is never made in a system folder or at `/`.

| From | Address |
| --- | --- |
| Home network | `https://192.168.1.2:8443` |
| Outside (through Cloudflare) | `https://sprinkler.sparknv.win:8443` |

Cloudflare's proxy only passes some ports (443, 2053, 2083, 2087, 2096, 8443). That is why 8443 is used.

## The files

All of them are in `~/.config/strata-remote/`. Only Spark can read the folder.

| File | What it is |
| --- | --- |
| `remote.json` | `port`, `host`, `key`, `cert`, `certKey`, `allow`. Give the key to your apps. To change it, write a new key of at least 32 characters and restart the app. A new key also signs every browser out. |
| `cert.pem`, `key.pem` | A self-made certificate for `sprinkler.sparknv.win`, `192.168.1.2` and `localhost`, valid until 2036. Clients on the home network must trust `cert.pem`, or they get a certificate warning. |

**Who may connect** (`allow`): by default `["lan", "cloudflare"]`, the home network and Cloudflare's proxy. A connection
from any other address is closed before anything is read, so the port forwarded on the router only serves Cloudflare;
going to the public IP directly does not even reach the sign-in page. Add `"any"` to allow every address (not needed for
the outside address, which goes through Cloudflare). Cloudflare's address list is in the code, taken from
cloudflare.com/ips on 2026-11-08.

**A wrong password's picture:** `personal/magic-word.webp` in this repository, named by `"failImage"` in `remote.json`
(any .webp, .gif, .png or .jpg). Without it, a wrong password shows "Login failed."

The launcher (`personal/strata-app`, installed as `~/.local/bin/strata-app`) turns remote access on with
`STRATA_REMOTE_CONFIG`. Remove that line, or set `"enabled": false` in `remote.json`, to turn it off.

## Setup outside this PC

1. **Firewall on this PC.** ufw is on. Allow the port:

   ```sh
   sudo ufw allow 8443/tcp
   ```

2. **Router.** Forward TCP port 8443 to `192.168.1.2:8443`.
3. **Cloudflare.** The hostname is proxied (orange cloud).
   - With SSL mode **Full**, the self-made certificate works.
   - With **Full (strict)**, Cloudflare answers `526`. Then make an Origin Certificate in the Cloudflare
     dashboard (SSL/TLS → Origin Server), save it over `cert.pem` and `key.pem`, and restart the app.
   - Cloudflare's free plan cuts a request off after 100 seconds with no data. Strata's streams send data
     while they work. It also limits uploads to 100 MB.

## Signing in

- **Browser:** open the address. A page titled **Login** shows only a box and a button: type the key. It sets a cookie
  named `session` for 30 days. `/logout` signs out.
- **Nothing names the app to a stranger.** Without the key, the login page, its paths (`/login`, `/logout`), the
  cookie and every refusal (`401 Unauthorized`, `429 Too Many Requests` and so on, as plain text) say nothing about
  Strata, an API or a model. Only after the key is accepted does the real app answer.
- **Apps and scripts:** send `Authorization: Bearer <key>` (or `x-api-key: <key>`) with every request.
- **Wrong keys:** after 10 wrong keys from one address, or 100 in all, within 15 minutes, every wrong try is
  refused until the 15 minutes are over. The right key always works, so nobody can lock you out by sending wrong
  keys. Behind Cloudflare, the caller's address is the one Cloudflare names; that header is only believed from
  Cloudflare's own addresses. The app log says `remote access · wrong key from …`.

## For an app (iOS, the laptop)

Send the key, and `x-strata-client: <your app's name>`, with every request. The host refuses some routes
without that header. The desktop app's page is the reference for every request: `apps/host/src/lib/client.ts`
and the screens that call it.

| What | Request |
| --- | --- |
| OpenAI API | `POST /v1/chat/completions`, `GET /v1/models` |
| Anthropic API | `POST /v1/messages` |
| Chats, saved like the desktop app's | `GET /api/chats`; `GET`, `PUT`, `DELETE /api/chats/<id>` |
| Send a chat message (Chat, Code, Vibe…) | `POST /api/chat/stream`; the answer is NDJSON, one frame per line |
| Live events (model state, chats changed) | `GET /api/events` (server-sent events) |
| Wake the text model | `POST /api/pinned/start` |
| Image model state, load, unload | `GET /api/image-model`; `POST /api/image-model/load`, `/unload` |
| LoRAs and whether editing works | `GET /api/image-model/extras` |
| A picture to edit | `POST /api/images/ref` `{ "data": "<base64 or data URL>" }` → `{ name }` |
| Make or edit images | `POST /api/images/generate` → NDJSON frames: `phase`, `progress`, `image`, `done`, `error` |
| An image | `GET /api/images/file/<name>` |

The OpenAI and Anthropic APIs on `/v1` wake the text model first, when it sleeps or the image model has the
GPU. A request may take as long as the model takes to start, about a minute.

## Measured

On this PC, over `https://192.168.1.2:8443`, on 2026-11-08:

- without the key, and with a wrong key: `401`;
- a browser without the key: sent to the sign-in page;
- with the key: the chat list, the image model state, the page itself, the live events, and `/v1/models`,
  which woke the sleeping text model;
- `/v1/chat/completions` answered.

Through Cloudflare (`https://sprinkler.sparknv.win:8443`), the same day, after the Configuration Rule that sets SSL
**Full** for this hostname on port 8443 only (the zone stays Flexible for the Caddy site): the same results.

Bypass attempts through Cloudflare, all refused with `401` (or `403`/`405`/`400`): no key, the key in the query
string, a wrong Bearer key, a made-up cookie, the key itself as the cookie, Basic auth, an empty Bearer, `/v1` and
`/v1/messages` without the key, path tricks (`//api/…`, `/login/../../api/…`, `%2f`), faked local
`X-Forwarded-For`, `Origin` and `Host`, an absolute request target, TRACE and CONNECT, a WebSocket upgrade. Quit with
the key: `403`. Outside servers going to the public IP directly: connection reset. The host (47831) and the model
(8082) do not answer on the network address at all.

**Not tested yet:** an iPhone, the laptop away from home.

## Weak connections (phase 1, for the iPhone app)

Requests that send `persist: true` are saved by the host itself, so a phone on a bad signal loses nothing and never runs a
message twice. Nothing changes for requests without it; the desktop app does not use it yet.

- `server/persisted-turn.mjs` runs such a turn: one save with the message and the reply placeholder before the model wakes,
  `queued` / `saved` / `status` frames at once, the reply saved every 5 s and at the end. Chat, Code and Vibe turns keep running
  without a connection; roleplay and pictures stop and keep what they have.
- `server/turn-ledger.mjs` keeps every `turnId` for 24 h on disk (`chats/turns.json`): a repeat joins or replays, never starts
  twice; `GET /api/chat/turn` answers `unknown` for one never received.
- `server/turn-record.mjs` builds the reply and the history (`history: "from-chat"`) with the desktop's rules; a test compares
  them with the desktop's own code.
- `server/chat-merge.mjs` and `chats/<id>.meta.json`: a save from an older copy is merged by message id (hash per version, 30 days).
- `PATCH /api/chats/<id>` (top-level fields), `/api/events?topics=…` (no 60 KB `monitor` event every second unless asked),
  pictures kept in `chats/media/<id>/`, the same approval / answer / Stop again answered `already`.

The iPhone docs (`~/Videos/Working/10-PHASE1.md`) hold every request and frame, with real captures.
