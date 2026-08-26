# Configuration and security

Environment variables, where Hilbert keeps its files, and what the backend does
and does not allow. The [README](../README.md) covers installing and using it.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOW_CODE_EXECUTION` | `1` | Set to `0` to disable all code execution. |
| `EXEC_TIMEOUT_MS` | `45000` | Per-run wall-clock limit. |
| `HILBERT_SANDBOX` | `auto`, `require` when hosted | `auto` runs code unconfined where no sandbox exists; `require` refuses to run it; `off` never confines. |
| `HILBERT_SANDBOX_NET` | `0` | `1` keeps the sandbox but gives the code back its network. |
| `HILBERT_CODE_SCREEN` | `auto` | `always` keeps the source pattern screen on under a sandbox; `off` never screens. |
| `HILBERT_SERVER_TOKEN` | none | Required 32+ character browser sign-in secret for `--hosted-server`. |
| `HILBERT_SESSION_HOURS` | `24` | How long a hosted browser session lasts, 1–720. |
| `HILBERT_PUBLIC_HOST` | none | Hosted only: the hostname this server is published as. Requests arriving under any other name are refused. |
| `HILBERT_API_TOKEN` | generated | Optional 32+ character API-token override. Hosted mode otherwise derives a stable, separate session token from its server token and workspace. |

Interpreters (including conda environments) are auto-detected; choose the default per
language in **App Settings → Interpreters**, and the choice is remembered. Your
documents live in `~/Documents/Hilbert`. Each workspace keeps its scratch files in a
hidden `.hilbert/` folder, which is safe to delete.

Settings, the last session, and the activity log sit together in one folder:

| Platform | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/hilbert/` |
| Linux | `~/.config/hilbert/` |
| Windows | `%APPDATA%\hilbert\` |

`settings.json` holds the preferences, `session.json` the project and open files you
left behind, and `hilbert.log` the last few thousand lines of what the engine has been
doing. Deleting any of them is safe; you get the defaults back.

---

## Security model

The backend is built for local, single-user use:

- It binds to `127.0.0.1` only, and CORS is limited to `localhost` and `127.0.0.1`.
  Requests carrying a foreign `Origin` or `Host` header are rejected, so a website you
  happen to have open cannot reach it.
- Every API request additionally needs a random bearer token minted at launch and
  handed only to the app's own window, so other local processes can't drive the
  backend either. Headless/scripted use sets it explicitly:
  `HILBERT_API_TOKEN=<32+ chars>` in the environment, then send
  `Authorization: Bearer <token>` with each request.
- File access is confined to the workspace, and path traversal is rejected.
- The collaboration listener is a separate binary-only relay with bounded rooms,
  peers, frame size, and traffic rate. Document and awareness frames are AES-GCM
  encrypted in the clients; the relay receives only ciphertext. Invitations contain
  the temporary decryption key, so share them only with intended collaborators.
  Set `HILBERT_COLLAB=0` to not start the listener at all, and `HILBERT_COLLAB_PORT`
  to move it off 3020.
- Code execution can be turned off (`ALLOW_CODE_EXECUTION=0`). When on, it is
  time-limited, runs in a scratch directory under `.hilbert/run/` with OS resource
  limits on file size and CPU, and has its output capped.
- On Linux and macOS a run is confined by the kernel: bubblewrap on Linux, Seatbelt
  on macOS. The code can write to its own run directory and nowhere else, has no
  network, and cannot read `~/.ssh`, `~/.gnupg`, `~/.aws` and the other credential
  directories. Figures still reach the document — the app copies them out afterwards.
  On Linux it also gets its own process, IPC and hostname namespaces.
- Where a sandbox is active the older pattern screen steps aside, since the kernel is
  enforcing the boundary the patterns were guessing at. Where there is none — Windows,
  or `HILBERT_SANDBOX=off` — the screen still refuses process, network, shell and
  destructive calls, and App Settings → Interpreters says which is in force.
- Wolfram is not confined. `wolframscript` launches a separate kernel over a loopback
  socket and decides which kernel from state outside the run directory; confining it
  either stops it starting or silently switches it to a different Mathematica version.
  It keeps the pattern screen instead, exactly as before.

Don't expose port 3001 to a network. For running documents you genuinely do not
trust, the sandbox is a real boundary but not the only one worth having: a container
or a VM still costs you nothing and assumes less.

Cloud credentials (Google Drive OAuth, WebDAV) live only in your browser's local
storage. A GitHub token is used for the one push you asked for and is never written to
`.git/config`.
