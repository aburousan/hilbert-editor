"""Native Linux smoke test. Run under xvfb-run with a built dist directory.

Uses the installed Hilbert backend, GTK and WebKitGTK, not Chromium. All
projects, settings and screenshots belong to an isolated temporary directory.
"""
import json
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('dist', type=Path)
parser.add_argument('--allow-gui', action='store_true', help='Explicitly permit launching native/WebKit windows; do not use on a machine reporting hangs.')
parser.add_argument('--budget', type=int, default=int(os.environ.get('HILBERT_SMOKE_BUDGET', '180')),
                    help='Seconds to allow the whole run. A slow machine with software rendering needs more than the default.')
args = parser.parse_args()
if not args.allow_gui:
    parser.error('GUI tests are opt-in. Diagnose device hangs with read-only checks first.')

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, GLib, WebKit2

dist = args.dist.resolve()
binary = os.environ.get("HILBERT_BIN", "/usr/bin/hilbert")
root = Path(tempfile.mkdtemp(prefix="hilbert-webkit-"))
workspace = root / "workspace"
workspace.mkdir()
(workspace / "main.typ").write_text('= Native WebKit test\n\nHello $x^2$.\n\n\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd\n\n\u0645\u0631\u062d\u0628\u0627 $E = m c^2$\n', encoding="utf-8")
(workspace / "drawing.excalidraw").write_text(json.dumps({"elements": [], "appState": {}}))
(root / "session.json").write_text(json.dumps({"workspacePath": str(workspace), "openPaths": ["main.typ"], "activePath": "main.typ", "mainFile": "main.typ"}))
(root / "settings.json").write_text('{"proofreading":false}')
token = "hilbert-native-smoke-0123456789abcdef"
env = dict(os.environ, TYPST_DIST=str(dist), TYPST_WORKSPACE=str(workspace),
           HILBERT_SESSION_FILE=str(root / "session.json"), HILBERT_SETTINGS_FILE=str(root / "settings.json"),
           HILBERT_INTERPRETERS_FILE=str(root / "interpreters.json"), HILBERT_API_TOKEN=token,
           XDG_DATA_HOME=str(root / "data"), XDG_CACHE_HOME=str(root / "cache"),
           PORT="3095", WEBKIT_DISABLE_DMABUF_RENDERER="1")
print("Artifacts:", root, flush=True)
with (root / "native.log").open("w") as log:
    native = subprocess.Popen([binary], env=env, stdout=log, stderr=log)
    try:
        time.sleep(20)
        if native.poll() is not None:
            raise RuntimeError("Native Tauri window exited: " + (root / "native.log").read_text())
        subprocess.run(["import", "-window", "root", str(root / "tauri.png")], check=True, timeout=15)
    finally:
        native.terminate()
        try:
            native.wait(timeout=10)
        except subprocess.TimeoutExpired:
            native.kill()
            native.wait()

log = (root / "backend.log").open("w")
server = subprocess.Popen([binary, "--headless"], env=env, stdout=log, stderr=log)
try:
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError("Backend exited: " + (root / "backend.log").read_text())
        try:
            urllib.request.urlopen("http://127.0.0.1:3095/", timeout=1).close()
            break
        except OSError:
            time.sleep(0.1)
    manager = WebKit2.UserContentManager()
    manager.add_script(WebKit2.UserScript.new(
        'document.cookie="hilbert_session=' + token + '; path=/"; window.smokeErrors=[]; addEventListener("error",e=>smokeErrors.push(e.message));',
        WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
    view = WebKit2.WebView.new_with_user_content_manager(manager)
    window = Gtk.Window()
    window.set_default_size(1440, 920)
    window.add(view)
    window.show_all()
    outcome = {"ok": False}
    started = False

    def finished(_manager, result):
        try:
            value = result.get_js_value()
            state = json.loads(value.to_string())
            if not state:
                return
            if 'progress' in state:
                print('WebKit:', state['progress'], flush=True)
                return
            outcome.update(state)
            subprocess.run(["import", "-window", "root", str(root / "webkit.png")], check=True, timeout=15)
            Gtk.main_quit()
        except Exception as error:
            outcome["error"] = str(error)
            Gtk.main_quit()

    manager.register_script_message_handler('smoke')
    manager.connect('script-message-received::smoke', finished)

    def loaded(webview, event):
        global started
        if event != WebKit2.LoadEvent.FINISHED or started or webview.get_uri() != 'http://127.0.0.1:3095/':
            return
        started = True
        script = ("const STEP_TRIES=%d;\n" % (args.budget * 2)) + r"""
        (async () => {
          const wait = async (fn, label) => {
            window.webkit.messageHandlers.smoke.postMessage(JSON.stringify({progress:label}));
            for (let i=0;i<STEP_TRIES;i++) { if(fn()) return; await new Promise(r=>setTimeout(r,250)); }
            throw Error('Timed out: '+label);
          };
          await wait(()=>document.querySelector('.view-line'), 'Monaco');
          await wait(()=>document.querySelector('.pdf-page canvas'), 'PDF');
          const canvas=document.querySelector('.pdf-page canvas');
          const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
          let ink=0;
          for(let i=0;i<pixels.length;i+=4) if(pixels[i+3]&&pixels[i]<180&&pixels[i+1]<180&&pixels[i+2]<180) ink++;
          if(ink<100) throw Error('PDF canvas is blank');
          if(![...document.querySelectorAll('.view-line')].some(el=>getComputedStyle(el).direction==='rtl')) throw Error('RTL line not decorated');
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',ctrlKey:true,bubbles:true}));
          await wait(()=>document.querySelector('.palette-input'),'command palette');
          const search=document.querySelector('.palette-input');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'Feynman Diagram');
          search.dispatchEvent(new Event('input',{bubbles:true}));
          await wait(()=>[...document.querySelectorAll('.palette-item')].some(el=>el.textContent.includes('Feynman Diagram')),'Feynman search');
          const entry=[...document.querySelectorAll('.palette-item')].find(el=>el.textContent.includes('Feynman Diagram'));
          if(!entry) throw Error('Feynman command unavailable');
          entry.click();
          await wait(()=>document.querySelector('.modal-content svg'),'Feynman');
          if(getComputedStyle(document.querySelector('.modal-overlay')).position!=='fixed') throw Error('Missing dialog CSS');
          const selector=[...document.querySelectorAll('.modal-content select')].find(el=>el.options[0].text.includes('Insert template'));
          selector.value=selector.options[1].value; selector.dispatchEvent(new Event('change',{bubbles:true}));
          await wait(()=>!document.querySelector('[aria-label="Undo"]').disabled,'template insertion');
          document.querySelector('[aria-label="Undo"]').click();
          await wait(()=>!document.querySelector('[aria-label="Redo"]').disabled,'undo');
          document.querySelector('[aria-label="Redo"]').click();
          document.querySelector('.modal-content .close-btn').click();
          [...document.querySelectorAll('.tree-file')].find(el=>el.textContent.includes('drawing.excalidraw')).click();
          await wait(()=>document.querySelector('.sci-palette button[title="Insert Circle"]'),'whiteboard');
          document.querySelector('.sci-palette button[title="Insert Circle"]').click();
          await wait(()=>document.querySelector('.sci-palette [role="status"]').textContent==='Unsaved','shape insertion');
          document.querySelector('.sci-palette .btn-primary').click();
          await wait(()=>document.querySelector('.sci-palette [role="status"]').textContent==='Saved','save drawing');
          if(smokeErrors.length) throw Error(smokeErrors.join('; '));
          window.smokeResult={ok:true,ink,checks:['PDF pixels','RTL decoration','Feynman template/undo/redo','whiteboard save']};
        })().catch(error=>{window.smokeResult={ok:false,error:String(error),errors:window.smokeErrors}})
          .then(()=>window.webkit.messageHandlers.smoke.postMessage(JSON.stringify(window.smokeResult)));
        'scheduled';
        """
        def evaluated(webview, result, *_):
            try:
                webview.evaluate_javascript_finish(result)
            except Exception as error:
                outcome['error'] = str(error)
                Gtk.main_quit()
        view.evaluate_javascript(script, -1, None, None, None, evaluated, None)

    def timeout():
        outcome["error"] = "Native WebKit smoke test timed out"
        subprocess.run(["import", "-window", "root", str(root / "timeout.png")], timeout=15)
        Gtk.main_quit()
        return False

    view.connect("load-changed", loaded)
    GLib.timeout_add_seconds(args.budget, timeout)
    view.load_uri("http://127.0.0.1:3095/")
    Gtk.main()
    print(json.dumps(outcome), flush=True)
    (root / "result.json").write_text(json.dumps(outcome, indent=2))
    if not outcome["ok"]:
        sys.exit(1)
    drawing = json.loads((workspace / "drawing.excalidraw").read_text())
    assert any(el["type"] == "ellipse" for el in drawing["elements"])
    assert (workspace / "drawing.svg").is_file()
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
    log.close()
