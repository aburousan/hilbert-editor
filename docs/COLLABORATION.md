# Live collaboration (experimental)

Hilbert lets two or more people work on the same project at the same time, the way
Overleaf does, but without an account and without a server that anyone runs for you. The
editing goes peer to peer over a small relay. That relay can be one collaborator's own
Hilbert (the app opens a listener when it starts), or a machine you run yourself, such as
a spare server or a Raspberry Pi.

Everything shared during a session is encrypted before it leaves your machine. The relay
only forwards the scrambled bytes and never sees your text or your files. The key that
unlocks it rides inside the invitation you share, so treat an invitation like a password.

> **This feature is experimental.** It works, and it has been tested across machines and
> networks, but it still has rough edges: an occasional reconnect, a file that lands a
> few seconds late, or an asset that needs a moment to appear. Nothing is deleted without
> asking you first, and your files always stay on your own disk — but keep your own
> backup of anything important before you rely on a live session.

## What gets shared

The whole project, not just one file:

- Every text file — `.typ`, `.bib`, notes, code — merged live, character by character.
- Images, fonts, PDFs and other binary assets, transferred separately and verified by
  content hash.
- Whiteboards (`.excalidraw`), which sync when saved rather than stroke by stroke.
- Plots your code generates, so the other person does not have to run the code to see
  the figure.
- File creations, renames and deletions.
- Everyone's cursor and selection, labelled with their display name.

Each person keeps a real copy of the project on their own disk and compiles it locally,
so the preview each of you sees is your own Typst build of the real document.

## What you need

- Hilbert running on each person's computer.
- A network path between the machines. On the same Wi-Fi that is automatic. Across a
  campus or the internet it needs one reachable address, which is covered below.
- An open text file on the host's side, so there is a document to start from.

## Hosting a session

1. Open the project you want to share, with a text file open in the editor.
2. Open the command palette (Ctrl/Cmd+K) and pick **Share this project live
   (experimental)…**, or click Share and switch to the **Live (experimental)** tab.
3. Hilbert suggests an address other people can reach. On a home or hostel network this
   is usually your machine's LAN address, something like `ws://192.168.1.20:3020`.
   Accept it or type a different one.
4. Enter a display name so collaborators can tell whose cursor is whose.
5. Start the session. The invitation is copied to your clipboard. Send it to the people
   you want to work with.

![Hosting an encrypted collaboration in Hilbert](collab-host.png)

The invitation looks like this:

```
hilbert-collab://join?server=ws://192.168.1.20:3020&room=<random id>&key=<random key>
```

The room id and the key are generated fresh every time you start a session. Anyone
holding the invitation can join and read the whole project, so send it over a channel you
trust.

## Joining a session

1. Open the command palette and pick **Join a shared project (experimental)…**, or click
   Share, go to the Live tab, and choose Join shared project.
2. Paste the invitation.
3. Choose where the project should live. Hilbert offers a new folder, and — if you have
   joined before — the folders you used previously. Picking a previous folder continues
   from the files already there.
4. Enter your display name.
5. Join. The project downloads into that folder, opens, and from then on everyone sees
   each other's edits as they happen.

![A joined encrypted collaboration session, with the participant badge in the header](collab-session.png)

A badge in the header shows how many people are connected; click it for session details
and the option to leave.

### Rejoining later

If you leave a session and join again, pick the same folder from the dropdown rather than
creating a new one. Hilbert then merges instead of starting over:

- Files the session also has are updated to the session's version, which is the merged
  state of everyone still connected.
- Files only you have are shared back up, so nothing you made while away is stranded.
- Files that were deleted while you were away are **listed and you are asked** before
  anything on your disk is touched.

One limitation worth knowing: the shared model carries no timestamps, so a file you
edited locally *while disconnected* loses to the session's copy when you rejoin. If you
did offline work you want to keep, copy it aside before rejoining.

## Network scenarios

### Everyone on one router

The easy case: a home, a lab, or a shared flat where every machine sits behind the same
Wi-Fi router. The host's LAN address — the `192.168.x.x` or `10.x.x.x` one Hilbert
suggests — is reachable by everyone else on that router. Host, share the invitation,
join, done.

If the host machine has a firewall on, allow inbound TCP on the collaboration port
(3020 by default).

### Across a campus or office network

Some networks are not one router. A common layout gives each room or desk its own
ethernet port, with people plugging their own router into it. Two people behind two
different routers each have a `192.168.x.x` address that is private to their own router,
and neither can reach the other.

What does work is the address the network itself hands you — the one you would use to
`ssh` between machines. If you can `ssh` or `ping` from your friend's machine to yours by
some address, that same address works for collaboration.

Two ways to get there:

- Plug the host machine straight into the network instead of going through a personal
  router, so it gets an address other rooms can reach, then host on that address.
- Or run a relay on a machine that already has a reachable address and have everyone
  point at it. That is the next section, and it is usually cleaner.

The rule of thumb: pick an address the person joining can actually reach. If a plain
`ssh` to it works from their side, collaboration will too.

### A dedicated relay (a server or a Raspberry Pi)

Instead of one collaborator hosting, you can run a small relay on a machine that stays on
and is easy to reach, then point everyone at it. Any always-on box does the job — a
single-board computer on the local network, a home server, or a rented one.

Run Hilbert in server mode on that machine:

```sh
hilbert --sync-server --port 3020
```

It prints the address to hand out. All it does is forward encrypted frames between people
in the same room. It has no workspace and no files, and it cannot read anything anyone
types.

Then set that address once in each person's Hilbert: command palette, **Set optional
collaboration server…**, and enter it, for example `ws://<relay address>:3020`. After
that, hosting uses the relay automatically, so whoever starts a session no longer has to
stay online for the rest. As long as the relay is up, the session stays alive.

A relay is also usually the faster setup. Every edit already travels through a relay in
any session; the only choice is whose machine plays that role. Put it on a well-placed box
that everyone reaches over a short, direct route and the round trip is small. That
generally beats connecting through a slow overlay network or across two home routers,
where the path wanders before it reaches the other person.

For a machine that should survive reboots, run the server under a process manager —
systemd, or a quick `tmux`/`screen` session — so it comes back on its own.

One note on Raspberry Pi and other ARM machines: the prebuilt Hilbert downloads are for
Intel and AMD computers, so there is no ready-made binary for a Pi. Build it from source
there instead, which the next section covers. The build takes a while, but you only do it
once.

If the relay sits on the public internet rather than a private network, put it behind TLS
and use a `wss://` address, or tunnel it, so the transport is protected on top of the
per-session encryption.

### A complete browser-hosted workspace

The relay above only forwards encrypted collaboration traffic: everyone still runs the
desktop app and keeps their own project copy. Hilbert can instead host the editor, files,
compiler, preview, and collaboration together, for an Overleaf-like setup in a browser:

```sh
npm run build
cd src-tauri
cargo build --release
HILBERT_SERVER_TOKEN="replace-with-a-random-secret-of-at-least-32-characters" \
  TYPST_DIST=../dist \
  ./target/release/typst-editor --hosted-server \
  --bind 127.0.0.1 --port 3001 --workspace /srv/hilbert/project
```

Open `http://127.0.0.1:3001` and sign in with the value of
`HILBERT_SERVER_TOKEN`. The token is accepted only by the sign-in form; Hilbert then
uses an HttpOnly session cookie, so the secret is not placed in the URL or browser
storage. The first signed-in browser becomes the collaboration host and later browsers
join it automatically. Edits, cursors, the PDF preview, generated plots, whiteboards,
and saved files update through the same server.

The authenticated browser session and encrypted hosted collaboration room are stable
across an ordinary process restart as long as the same `HILBERT_SERVER_TOKEN` and
workspace path are used. Changing either intentionally rotates those derived secrets
and asks browsers to sign in to the new hosted workspace identity.

Use `--bind 0.0.0.0` only when other machines need to reach it. Encrypted browser
collaboration requires a secure browser context: use an HTTPS reverse proxy even on a
LAN, or reach the loopback listener through an SSH tunnel. Browsers deliberately do not
expose Web Crypto to a page opened as plain `http://<LAN address>`, so that address can
still edit and compile but cannot start the encrypted live channel. With HTTPS the app
uses secure `https://` and `wss://` connections. `/healthz` is an unauthenticated health
endpoint suitable for a process monitor. The workspace path is fixed at startup and
signed-in browsers cannot change it.

For example, if the server is reachable by SSH through a campus network but is not on
the same Wi-Fi, leave Hilbert bound to loopback and run this on each client:

```sh
ssh -N -L 3001:127.0.0.1:3001 user@server.example.edu
```

Then open `http://127.0.0.1:3001` locally. The browser treats loopback as a secure
context for Web Crypto, while SSH encrypts the campus-network hop and avoids exposing
the Hilbert port to other campus users. Choose another unused local port on the left
side of `-L` when port 3001 is already occupied.

Unlike invitation-based desktop collaboration, browser-hosted mode does **not** create
an automatic offline project folder on each visitor's device. The server workspace is
the authoritative copy. Use project export or another backup/sync method when someone
needs a separate local copy.

Unsaved text has an additional outage safety net. While the hosted page is open,
Hilbert writes each dirty text buffer to IndexedDB on that device (with a smaller
localStorage fallback) until the server confirms the save. It retries a failed save
after the server returns. On the next load at the same browser origin, a draft whose
server base is unchanged is replayed automatically; if the server copy changed too,
Hilbert preserves both and asks which one to open instead of overwriting either.

This recovery store is not a replacement for server backups or a complete offline
installation: a browser cannot freshly load the hosted UI while the server is down,
clearing site data removes that browser's recovery drafts, and using a different
hostname or SSH local port creates a different browser origin. Keep the same tunnel
port/URL and browser profile when recovering, and back up the authoritative server
workspace normally.

Signed-in users can run the workspace's Python, Julia, or Wolfram code when code
execution is enabled. Those runners have time and resource guardrails, but they are not
a hardened security boundary. Set `ALLOW_CODE_EXECUTION=0` if collaborators should not
run code, and use a dedicated OS account, container, or VM when hosting documents you do
not fully trust.

## Running from source

You need [Rust](https://www.rust-lang.org/tools/install) and
[Node.js](https://nodejs.org/). On Linux, including a Raspberry Pi, you also need the
system libraries that Tauri builds against. The current list lives on the
[Tauri prerequisites page](https://v2.tauri.app/start/prerequisites/); on Debian or
Raspberry Pi OS it is roughly:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Then build and run:

```sh
git clone https://github.com/aburousan/hilbert-editor
cd hilbert-editor
npm install
npm run build
cd src-tauri
cargo run --release
```

The first build compiles a lot, so give it time. After that, the same binary runs the
normal app, and with the flag it runs as a relay instead:

```sh
cargo run --release -- --sync-server --port 3020
```

Once it is built you can also call the binary directly:

```sh
./target/release/typst-editor --sync-server --port 3020
```

## Troubleshooting

**"The host was reached but no document synchronized."** The relay is reachable but the
session is not answering — usually the host left, or the invitation is from an older
session. Ask for a fresh invitation.

**Nothing happens when joining.** Check the address in the invitation is one your machine
can reach; `ping` or `ssh` to it first. If the host is behind a firewall, port 3020 needs
to be open inbound.

**A file looks out of date.** Sessions reconcile every few seconds, so give it a moment.
If it persists, leaving and rejoining the same folder re-syncs from the session's state.

**An image is missing in the preview.** The bytes travel separately from the text that
references them, so a large asset can arrive a moment after the document does. The
preview recompiles by itself once it lands.

**Someone's whiteboard changes are not showing.** Whiteboards sync on save, not stroke by
stroke. Ask them to save (Ctrl/Cmd+S) in the whiteboard tab.

## Good to know

- The invitation contains the session key. Anyone who has it can read the whole project,
  so share it only with the people you mean to.
- Saving, compiling and export all keep working during a session. The files on disk are
  still yours, and stay after the session ends.
- Leaving a session is deliberate and ends it on your side. The key is not kept
  afterwards, so rejoining needs a fresh invitation.
- The collaboration listener starts on port 3020 when the app launches. Set
  `HILBERT_COLLAB_PORT` to move it. Set `HILBERT_COLLAB=0` to turn it off completely and
  keep Hilbert strictly local.
- That listener only ever carries the encrypted relay. It never exposes the file API,
  which stays bound to your own machine.
