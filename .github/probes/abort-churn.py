#!/usr/bin/env python3
"""Drive the backend the way the editor does when someone types fast.

The earlier probe wrote a file, waited for the compile, wrote the next one. The
editor doesn't: every keystroke aborts the compile still in flight and starts
another. That's the path where a held compile slot or a leaked watcher would
show up, and it had never been measured. Ends by asking whether an ordinary
compile still answers promptly, which is the thing a wedge would take away.
"""
import os, subprocess, sys, time, socket, threading, urllib.request, http.client
from pathlib import Path

root = Path(sys.argv[1])
exe = sys.argv[2]
port = int(sys.argv[3])
token = "probe-token-long-enough-to-be-accepted-0123456789"

ws = root / "churn-ws"
ws.mkdir(parents=True, exist_ok=True)
state = root / "churn-state"
state.mkdir(parents=True, exist_ok=True)
dist = root / "churn-dist"
dist.mkdir(parents=True, exist_ok=True)
(dist / "index.html").write_text("<!doctype html><title>probe</title>")

body = "\n".join(f"Line {i} with some text to typeset, $x_{{{i}}} = sqrt(2)$." for i in range(100))
def document(marker):
    return f"= Churn {marker}\n\n{body}\n"

(ws / "main.typ").write_text(document("start"), encoding="utf-8")
log = root / "churn-backend.log"
env = dict(os.environ,
           HILBERT_API_TOKEN=token,
           TYPST_WORKSPACE=str(ws),
           TYPST_DIST=str(dist),
           HILBERT_SESSION_FILE=str(state / "session.json"),
           PORT=str(port))
with open(log, "w") as sink:
    backend = subprocess.Popen([exe, "--headless"], stdout=sink, stderr=subprocess.STDOUT, env=env)

def wait_for_port():
    for _ in range(120):
        time.sleep(0.5)
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            pass
    return False

def request(method, path, data=None, ctype=None, timeout=120):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if ctype:
        req.add_header("Content-Type", ctype)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()

def compile_and_drop(after_ms):
    """Start a compile and hang up part-way, exactly as an aborted fetch does."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
    conn.request("POST", "/compile?main=main.typ", body=b"",
                 headers={"Authorization": f"Bearer {token}", "Content-Length": "0"})
    time.sleep(after_ms / 1000)
    conn.close()

try:
    if not wait_for_port():
        print(log.read_text(errors="replace"))
        raise SystemExit("backend never listened")
    # Let the watcher come up and do its first cycle.
    request("POST", "/compile?main=main.typ", b"")

    print("abort churn: 40 edits, each hanging up on the one before")
    for i in range(40):
        request("POST", "/workspace/file?path=main.typ",
                document(f"churn-{i}").encode(), "text/plain")
        compile_and_drop(40)          # shorter than a compile takes
        time.sleep(0.05)

    print("  churn done; now asking for one compile the normal way")
    for attempt in range(3):
        request("POST", "/workspace/file?path=main.typ",
                document(f"after-{attempt}").encode(), "text/plain")
        start = time.time()
        status, pdf = request("POST", "/compile?main=main.typ", b"", timeout=90)
        elapsed = (time.time() - start) * 1000
        print(f"  settle {attempt}: {round(elapsed)} ms, {status}, {len(pdf)} bytes")
        time.sleep(0.3)

    # A wedge shows up as leaked typst processes as much as as a slow reply.
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq typst.exe"],
                             capture_output=True, text=True).stdout
        print("  typst processes:", out.count("typst.exe"))
    else:
        out = subprocess.run(["pgrep", "-c", "-f", "typst watch"],
                             capture_output=True, text=True).stdout.strip()
        print("  typst watch processes:", out or "0")

    print("\n--- diagnostics tail ---")
    _, text = request("GET", "/diagnostics")
    lines = text.decode("utf-8", "replace").splitlines()
    for line in lines[:8]:
        print(line[:200])
    print("  ...")
    for line in lines[-15:]:
        print(line[:200])
finally:
    backend.kill()
