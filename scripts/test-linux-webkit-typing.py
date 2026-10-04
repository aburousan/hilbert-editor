"""Fast typing in Linux WebKit must land every character where it was typed.

The Linux counterpart of scripts/test-typing-regression.mjs (issue #31): a large
document compiling every 100 ms, real X keystrokes (XTest) at speed, and the
file on disk checked line by line afterwards. Also reports how long a keystroke
takes to reach the screen.

    xvfb-run -a -s "-screen 0 1600x1000x24" python3 scripts/test-linux-webkit-typing.py BIN DIST

Needs WebKitGTK 4.1 with its Python bindings and python-xlib.
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, GLib, WebKit2
from Xlib import X, XK, display as xdisplay
from Xlib.ext import xtest

binary, dist = sys.argv[1:3]
root = tempfile.mkdtemp(prefix="hilbert-wk-typing-")
ws = os.path.join(root, "ws")
os.makedirs(ws)
filler = "\n\n".join(
    f"Paragraph {i + 1}. This sentence exists to give the tokeniser and the compiler something to chew on "
    f"while the test types, with $x_{i % 9} + sqrt({(i % 7) + 1})$ and _emphasis_ and #strong[markup]."
    for i in range(3000))
main = os.path.join(ws, "main.typ")
open(main, "w").write(f'#set page(paper: "a4")\n\n= Typing\n\n{filler}\n')
json.dump({"workspacePath": ws, "openPaths": ["main.typ"], "activePath": "main.typ", "mainFile": "main.typ"},
          open(os.path.join(root, "session.json"), "w"))
json.dump({"compileDelay": 100, "proofreading": False}, open(os.path.join(root, "settings.json"), "w"))
token = "hilbert-wk-typing-token-0123456789abcd"
port = os.environ.get("PORT", "3098")
env = dict(os.environ, TYPST_DIST=dist, TYPST_WORKSPACE=ws, PORT=port, HILBERT_API_TOKEN=token,
           HILBERT_SESSION_FILE=os.path.join(root, "session.json"), HILBERT_SETTINGS_FILE=os.path.join(root, "settings.json"),
           HILBERT_RECOVERY_DIR=os.path.join(root, "recovery"), HILBERT_HISTORY_DIR=os.path.join(root, "history"),
           XDG_DATA_HOME=os.path.join(root, "data"), XDG_CACHE_HOME=os.path.join(root, "cache"),
           WEBKIT_DISABLE_DMABUF_RENDERER="1")
server = subprocess.Popen([binary, "--headless"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
origin = f"http://127.0.0.1:{port}/"
for _ in range(200):
    try:
        urllib.request.urlopen(origin, timeout=1).close()
        break
    except OSError:
        time.sleep(0.1)

x = xdisplay.Display()
NAMES = {" ": "space", ".": "period", ",": "comma"}


def tap(sym, mods=()):
    code = lambda s: x.keysym_to_keycode(XK.string_to_keysym(s))
    for m in mods:
        xtest.fake_input(x, X.KeyPress, code(m))
    xtest.fake_input(x, X.KeyPress, code(sym))
    xtest.fake_input(x, X.KeyRelease, code(sym))
    for m in reversed(mods):
        xtest.fake_input(x, X.KeyRelease, code(m))
    x.sync()


def char(c):
    if c.isupper():
        tap(c.lower(), ("Shift_L",))
    else:
        tap(NAMES.get(c, c))


manager = WebKit2.UserContentManager()
manager.add_script(WebKit2.UserScript.new(
    'document.cookie="hilbert_session=' + token + '; path=/";window.__keys=[];'
    'addEventListener("keydown",()=>{const t=performance.now();requestAnimationFrame(()=>setTimeout(()=>window.__keys.push(performance.now()-t),0))},true);',
    WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
view = WebKit2.WebView.new_with_user_content_manager(manager)
window = Gtk.Window()
window.set_default_size(1600, 1000)
window.move(0, 0)
window.add(view)
window.show_all()
result = {"trials": []}
before = [open(main).read()]


def ack(n):
    view.evaluate_javascript(f"window.__ack({n})", -1, None, None, None, None, None)


def on_message(_m, res):
    msg = json.loads(res.get_js_value().to_string())
    op = msg["op"]
    if op == "trial":
        after = open(main).read()
        b, a = before[0].split("\n"), after.split("\n")
        changed = [(b[i] if i < len(b) else None, a[i] if i < len(a) else None)
                   for i in range(max(len(a), len(b))) if (b[i] if i < len(b) else None) != (a[i] if i < len(a) else None)]
        s = msg["sentence"]
        ok = len(changed) == 1 and after.count(s) == 1 and changed[0][1] is not None and changed[0][1].replace(s, "") == changed[0][0]
        result["trials"].append({"delay": msg["delay"], "ok": ok, "lines_changed": len(changed)})
        before[0] = after
        return

    def run():
        if op == "click":
            xtest.fake_input(x, X.MotionNotify, x=int(msg["x"]), y=int(msg["y"]))
            xtest.fake_input(x, X.ButtonPress, 1)
            xtest.fake_input(x, X.ButtonRelease, 1)
            x.sync()
        elif op == "keys":
            for s in msg["syms"]:
                tap(s, tuple(msg.get("mods", ())))
        elif op == "type":
            chars = list(msg["text"])

            def nxt():
                if not chars:
                    ack(msg["id"])
                    return False
                char(chars.pop(0))
                return True
            GLib.timeout_add(msg["delay"], nxt)
            return False
        elif op == "done":
            result.update(msg["result"])
            Gtk.main_quit()
            return False
        ack(msg["id"])
        return False
    GLib.idle_add(run)


manager.register_script_message_handler("t")
manager.connect("script-message-received::t", on_message)

SCRIPT = r"""
(async () => {
  let n = 0; const waiting = {};
  window.__ack = id => { waiting[id]?.(); delete waiting[id]; };
  const act = o => new Promise(r => { const id = ++n; waiting[id] = r; window.webkit.messageHandlers.t.postMessage(JSON.stringify({ ...o, id })); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 600 && !document.querySelector('.pdf-page'); i++) await sleep(250);
  await sleep(4000);
  const keys = [];
  for (const [trial, delay] of [[1, 30], [2, 30], [3, 30], [4, 15], [5, 15]]) {
    const el = [...document.querySelectorAll('.view-line')].find(e => e.innerText.replace(/ /g, ' ').startsWith('Paragraph'));
    const r = el.getBoundingClientRect();
    await act({ op: 'click', x: r.left + Math.min(r.width - 20, 200), y: r.top + r.height / 2 });
    await sleep(400);
    await act({ op: 'keys', syms: ['End'] });
    await sleep(400);
    window.__keys = [];
    const sentence = ` Trial ${trial} at ${Date.now()} typed quickly.`;
    await act({ op: 'type', text: sentence, delay });
    keys.push(...window.__keys);
    await sleep(2000);
    await act({ op: 'keys', syms: ['s'], mods: ['Control_L'] });
    await sleep(4000);
    window.webkit.messageHandlers.t.postMessage(JSON.stringify({ op: 'trial', sentence, delay }));
    await sleep(300);
  }
  keys.sort((a, b) => a - b);
  const q = p => Math.round(keys[Math.min(keys.length - 1, Math.floor(p * keys.length))] || 0);
  window.webkit.messageHandlers.t.postMessage(JSON.stringify({ op: 'done', result: { keyP50: q(0.5), keyP95: q(0.95), keyMax: q(1) } }));
})().catch(e => window.webkit.messageHandlers.t.postMessage(JSON.stringify({ op: 'done', result: { error: String(e) } })));
'started';
"""

started = [False]


def loaded(v, e):
    if e != WebKit2.LoadEvent.FINISHED or started[0]:
        return
    started[0] = True
    v.evaluate_javascript(SCRIPT, -1, None, None, None, None, None)


view.connect("load-changed", loaded)
GLib.timeout_add_seconds(600, lambda: (result.update(error="timed out"), Gtk.main_quit()))
view.load_uri(origin)
Gtk.main()
server.terminate()
try:
    server.wait(timeout=10)
except subprocess.TimeoutExpired:
    server.kill()
shutil.rmtree(root, ignore_errors=True)
print(json.dumps(result), flush=True)
clean = "error" not in result and len(result["trials"]) == 5 and all(t["ok"] for t in result["trials"])
print("linux webkit typing: " + ("every character landed in order" if clean else "FAILED"), flush=True)
sys.exit(0 if clean else 1)
