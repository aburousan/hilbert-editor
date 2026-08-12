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

One gap worth knowing: what travels is files, so a folder you create and leave empty does
not appear for anyone else. It shows up the moment you put something in it.

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
compiler, preview, and collaboration together, for an Overleaf-like setup in a browser.

An installed copy can do this directly. `--serve` is the same thing as
`--hosted-server`, and the installed build already carries the web app, so there is
nothing to point it at:

```sh
HILBERT_SERVER_TOKEN="replace-with-a-random-secret-of-at-least-32-characters" \
  hilbert --serve --bind 127.0.0.1 --port 3001 --workspace /srv/hilbert/project
```

On macOS the binary lives inside the bundle, at
`/Applications/Hilbert.app/Contents/MacOS/hilbert`. Building from source instead, you
have to say where the built web app is, because there is no bundle to find it in:

```sh
npm run build
cd src-tauri
cargo build --release
HILBERT_SERVER_TOKEN="replace-with-a-random-secret-of-at-least-32-characters" \
  TYPST_DIST=../dist \
  ./target/release/typst-editor --serve \
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

A few things a browser tab cannot do, because they belong to the machine the app is
installed on rather than the one you are sitting at. Reveal in file manager and opening
a second native window are unavailable. Cut, copy and paste use the browser's own
clipboard rather than the server's, so the first paste may ask for clipboard permission,
and Firefox restricts reading the clipboard from a page more tightly than Chrome does.
Toolbar customization is remembered per browser, so hiding a button does not change what
anyone else sees.

Two ceilings protect the server's memory, and both apply only to what the browser is
shown. A file preview stops at 64 MiB and a compiled PDF at 96 MiB. The file itself is
untouched on disk and the compile still succeeds; only the in-browser preview is refused,
with a message saying so.

When you run this under systemd or from a terminal, SIGINT and SIGTERM go through the
normal shutdown path, so the compiler and language-server children are stopped rather
than orphaned. `systemctl stop` leaves nothing behind.

## Leaving it running

A hosted workspace is meant to sit there for months, and a command typed into a terminal
does not survive the terminal closing. The `deploy/` folder has what a real deployment
needs: a systemd unit, an nginx server block, and the same thing for Caddy.

### The service

`deploy/hilbert.service` runs Hilbert as a dedicated unprivileged `hilbert` account with
its own home under `/var/lib/hilbert`, restarts it if it dies, and stops it cleanly. The
header of that file lists the four commands that create the account, the workspace, and
the environment file. Install it with:

```sh
sudo install -m 644 deploy/hilbert.service /etc/systemd/system/hilbert.service
sudo systemctl daemon-reload
sudo systemctl enable --now hilbert
journalctl -u hilbert -f
```

Install bubblewrap too, before you enable the service:

```sh
sudo apt install bubblewrap        # or: sudo dnf install bubblewrap
```

A hosted workspace will not run code it cannot confine. Without `bwrap` the service still
starts and still serves and compiles documents; the Run buttons just say why they are
unavailable. See [Running other people's code](#running-other-peoples-code) below.

The unit is deliberately confined, because this service runs code its own users write:
no new privileges, a private `/tmp`, a read-only view of the filesystem apart from
`/var/lib/hilbert`, no access to kernel tunables or modules, and a memory ceiling. Three
of those choices are worth knowing about before you debug something.

`ProtectHome=yes` hides `/home` from the service, which also hides any interpreter
installed there. A conda environment under your own home directory is simply not found.
Install the interpreters system-wide, or relax that line to `ProtectHome=read-only` and
accept that a cell can then read every home directory on the box.

`RestrictNamespaces` and `SystemCallFilter` are looser than they first look, and that is
on purpose. Bubblewrap builds the box that user code runs in, and to do that it has to
create namespaces and mount things inside them — which `RestrictNamespaces=yes` and a
plain `@system-service` filter both forbid. Tightening those two lines produces a service
that looks well hardened, reports no sandbox available, and refuses to run anything.

`MemoryDenyWriteExecute` is left off on purpose. Julia compiles as it runs and needs
writable-executable pages; turning that protection on breaks every Julia cell.

### HTTPS

Hilbert binds to loopback and expects a reverse proxy to terminate TLS. Two headers in
that proxy are load-bearing rather than boilerplate:

- **`Host` must be passed through unchanged.** Hilbert checks each request's `Origin`
  against its `Host`, so a proxy that rewrites `Host` to the upstream name makes every
  browser request look cross-site and the server answers `403 Forbidden: cross-site
  request`. The site loads and then refuses everything you click.
- **`X-Forwarded-Proto` must say `https`.** It is how the app knows the visitor arrived
  over TLS, and it decides both whether the session cookie is marked `Secure` and whether
  the collaboration relay is offered as `wss://` or `ws://`.

The relay also needs a long read timeout, because the socket stays open for as long as
someone has the document open and is silent whenever nobody is typing. nginx's default
60 seconds closes it repeatedly and every editor reconnects in a loop.
`deploy/nginx-hilbert.conf` has all of this; `deploy/Caddyfile` is shorter because Caddy
passes `Host` through and sets `X-Forwarded-Proto` on its own.

### The token

`HILBERT_SERVER_TOKEN` is the sign-in secret for every visitor, and it lives in
`/etc/hilbert/hilbert.env` at mode 600, read by systemd as root before privileges are
dropped. To rotate it:

```sh
printf 'HILBERT_SERVER_TOKEN=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" \
  | sudo tee /etc/hilbert/hilbert.env >/dev/null
sudo chmod 600 /etc/hilbert/hilbert.env
sudo systemctl restart hilbert
```

Rotating it signs everyone out, which is the point, but it does more than that. The
hosted room and session keys are derived from the token and the workspace path, so a new
token is a new hosted workspace identity: open browser tabs stop being able to reach the
old room and have to sign in again. Files on disk are untouched. Do it if the token
leaks, or when someone who had it should no longer have access.

### Backups

The workspace directory is the authoritative copy of everything. Browser recovery drafts
are not a backup, and a browser cannot even load the UI while the server is down. Back up
`/var/lib/hilbert/workspace` the way you would back up any other directory of source
files. A `git` repository inside it works well and gives you history for free; a nightly
`rsync` or filesystem snapshot to another machine covers the case where this one dies.
Nothing outside the workspace needs backing up except `/etc/hilbert/hilbert.env`, and
that one you can just regenerate.

### Sessions

Signing in exchanges the token for a cookie. That cookie is not the token — it is a short
signed statement saying when the session expires and which generation of sessions it
belongs to, and the server checks both on every request. Three consequences:

- Sessions expire on the server, not on the browser's honour. The default is 24 hours;
  `HILBERT_SESSION_HOURS` in the environment file changes it, between 1 and 720.
- They survive a restart, so a browser that was mid-edit when the service bounced picks up
  where it was instead of losing the draft behind a sign-in page.
- They can be ended without changing the token. `POST /auth/revoke-sessions`, from a
  signed-in browser or with the API token, signs everyone out at once and leaves the
  sign-in secret alone. Use it for a lost laptop; rotate the token for a leaked token.

`POST /auth/logout` clears just the calling browser's cookie.

### Running other people's code

Everything above this line protects the machine from the network. This part is about the
code inside the documents, which is a different problem: a notebook cell is a program
somebody else wrote, and running it is the entire point of the feature.

On Linux each run happens inside bubblewrap. The cell gets its own PID, IPC and UTS
namespaces, an empty network namespace, a read-only view of the filesystem with the
credential directories (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`,
`~/.config/gh`, `~/.config/gcloud`) replaced by empty ones, and exactly one writable
directory: `.hilbert/run` inside the workspace, where it starts. Figures it produces are
copied out into `assets/` afterwards by the server, not by the cell. macOS gets the same
two guarantees — writes confined to the run directory, no network — through Seatbelt,
which cannot restrict reads as tightly, so the rest of the disk stays readable apart from
those same credential paths. Windows has neither.

Because the operating system is holding that line, the pattern-matching screen that used
to refuse anything mentioning `subprocess` or `os.environ` steps aside when a sandbox is
active: it was rejecting ordinary code and stopping nobody determined. Where there is no
sandbox, it still applies.

**Wolfram is the exception, and runs unconfined.** `wolframscript` is a launcher: it
starts a separate WolframKernel, talks to it over a loopback socket with link files in
`/tmp`, and works out which kernel to start from state under `~/Library`. Confined, the
kernel does not come up at all. Given loopback and `/tmp` it starts but silently picks a
*different* kernel — Wolfram Engine 14.2 in place of Wolfram 15.0 on the machine this was
tested on. Running someone's algebra on a quietly different version of Mathematica is a
worse outcome than not confining it, so Wolfram keeps the source screen — which refuses
`Run`, `RunProcess`, `URLFetch`, `Import` of a URL and the rest — as its guard. That is
what it had before, so nothing about Wolfram got worse; it just did not get better. If
that matters to you, `ALLOW_CODE_EXECUTION=0` or a machine of its own are the answers.

What this costs: a cell cannot write outside `.hilbert/run`, and it has no network. Code
that fetched a dataset mid-run, or wrote a CSV next to the document, needs changing —
write it in the run directory and it will be there.

Julia's package caches are the one exception, because Julia refuses to load a package it
cannot precompile: the depot's `compiled/`, `scratchspaces/` and `logs/` are writable,
and the package sources beside them are not. A few Julia packages also write straight
into your home directory — PlotlyJS and anything else built on WebIO keep a lock file at
`~/.jlassetregistry.lock` — and those fail to load under the sandbox. Plots.jl, which is
what the notebook runner is built around, does not do this and works normally.

Four settings, all in the environment file:

| Setting | Effect |
| --- | --- |
| `HILBERT_SANDBOX=require` | The default when hosted. No sandbox, no code execution. |
| `HILBERT_SANDBOX=auto` | Run code unconfined if the machine has no sandbox. The desktop default. |
| `HILBERT_SANDBOX=off` | Never confine anything. Means what it says. |
| `HILBERT_SANDBOX_NET=1` | Keep the sandbox, give the code back its network. |
| `HILBERT_CODE_SCREEN=always` | Keep the source screen on even under a sandbox. |

If you are hosting documents from people you do not trust at all, none of this is a
substitute for `ALLOW_CODE_EXECUTION=0`, or for giving the service a machine of its own:
a container or a VM, not just a separate account.

## Running from source

You need [Rust](https://www.rust-lang.org/tools/install) and
[Node.js](https://nodejs.org/). On Linux, including a Raspberry Pi, you also need the
system libraries that Tauri builds against. The current list lives on the
[Tauri prerequisites page](https://v2.tauri.app/start/prerequisites/); on Debian or
Raspberry Pi OS it is roughly:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libwayland-dev
```

`libwayland-dev` is the one people miss. The editor's clipboard talks to the system
clipboard directly, and on Linux that needs Wayland's headers present at build time even
when you are running X11.

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

**Paste does nothing in a browser tab.** A hosted page uses the browser's clipboard, not
the server's, and the browser has to grant the page permission to read it. Accept the
prompt the first time, or use Ctrl/Cmd+V, which browsers always allow because the
keystroke is the permission. The desktop app is not affected.

**The browser says a file is too large to preview.** Hosted mode stops showing a file
past 64 MiB, and a compiled PDF past 96 MiB, to keep the server's memory bounded. The
file is untouched and the compile still ran; download it or open the project in the
desktop app to see it.

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
