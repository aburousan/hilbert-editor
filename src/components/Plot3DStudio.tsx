import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Translate a numpy-style expression (X, Y, np.*) into JS for the live preview.
function toJs(expr: string): string {
  return expr
    .replace(/np\./g, 'Math.')
    .replace(/\bX\b/g, 'x')
    .replace(/\bY\b/g, 'y');
}

import { API } from '../api';

export default function Plot3DStudio({ onClose, onInsert, onSaved }: { onClose: () => void, onInsert: (code: string) => void, onSaved?: (path: string) => void }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const rebuildRef = useRef<() => void>(() => {});
  const [expr, setExpr] = useState('np.sin(np.sqrt(X**2 + Y**2))');
  const [range, setRange] = useState('5');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  // The scene is built once (empty-deps effect), so `build` would otherwise
  // close over the initial expr/range forever. Read the live values via refs.
  const exprRef = useRef(expr);
  const rangeRef = useRef(range);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const W = mount.clientWidth || 640, H = mount.clientHeight || 360;
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color('#0f172a');
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 1000);
    cameraRef.current = camera;
    camera.up.set(0, 0, 1);                 // z-up, matching matplotlib
    camera.position.set(9, -9, 7);

    let renderer: THREE.WebGLRenderer;
    // preserveDrawingBuffer lets us read the canvas back as a PNG on demand.
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch { setErr('WebGL is not available in this browser.'); return; }
    rendererRef.current = renderer;
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(6, -6, 12); scene.add(dl);
    scene.add(new THREE.AxesHelper(6));

    let mesh: THREE.Mesh | null = null;
    // Free EVERY GPU resource on the old surface — its geometry AND material, plus
    // the wireframe child's geometry and material. Disposing only mesh.geometry
    // (as before) leaked a material + wireframe geometry + wireframe material on
    // every rebuild; typing rebuilds per keystroke, so the leak piled up until the
    // GPU driver dropped the context and the view crashed.
    const disposeMesh = (m: THREE.Object3D | null) => {
      if (!m) return;
      scene.remove(m);
      m.traverse((o: any) => {
        if (o.geometry) o.geometry.dispose();
        const mat = o.material;
        if (Array.isArray(mat)) mat.forEach((x: any) => x.dispose());
        else if (mat) mat.dispose();
      });
    };
    const build = () => {
      let f: (x: number, y: number) => number;
      try { f = new Function('x', 'y', 'return (' + toJs(exprRef.current) + ')') as any; if (!isFinite(f(0.3, 0.4))) throw 0; setErr(''); }
      catch { setErr('Invalid expression — use X, Y and np.* (e.g. np.sin(X)*np.cos(Y)).'); return; }
      disposeMesh(mesh);
      const R = Math.abs(parseFloat(rangeRef.current)) || 5, N = 60;
      const geo = new THREE.PlaneGeometry(2 * R, 2 * R, N, N);
      const pos = geo.attributes.position;
      const zs: number[] = []; let zmin = Infinity, zmax = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        let z = f(pos.getX(i), pos.getY(i)); if (!isFinite(z)) z = 0;
        zs.push(z); pos.setZ(i, z); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
      }
      geo.computeVertexNormals();
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const t = (zs[i] - zmin) / ((zmax - zmin) || 1);
        const c = new THREE.Color().setHSL((1 - t) * 0.72, 0.75, 0.5);
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.55 }));
      const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12 }));
      mesh.add(wire);
      scene.add(mesh);
    };
    rebuildRef.current = build;
    build();

    let raf = 0;
    let alive = true;
    // If the browser drops the WebGL context (e.g. too many contexts, GPU reset),
    // stop the loop and tell the user instead of throwing every frame / crashing.
    const canvas = renderer.domElement;
    const onContextLost = (e: Event) => {
      e.preventDefault();
      alive = false;
      cancelAnimationFrame(raf);
      setErr('The 3D graphics context was lost — close and reopen the 3D Plot Studio.');
    };
    canvas.addEventListener('webglcontextlost', onContextLost as EventListener, false);

    const loop = () => {
      if (!alive) return;
      controls.update();
      try { renderer.render(scene, camera); }
      catch { alive = false; setErr('The 3D view stopped rendering — close and reopen the 3D Plot Studio.'); return; }
      raf = requestAnimationFrame(loop);
    };
    loop();
    const onResize = () => { const w = mount.clientWidth, h = mount.clientHeight; if (!w || !h) return; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); };
    const ro = new ResizeObserver(onResize); ro.observe(mount);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeMesh(mesh);
      canvas.removeEventListener('webglcontextlost', onContextLost as EventListener);
      // dispose() alone leaves the GPU context alive; forceContextLoss actually
      // frees it so reopening the studio doesn't pile up contexts (~16 max).
      try { renderer.forceContextLoss(); } catch {}
      renderer.dispose();
      rendererRef.current = null;
      try { mount.removeChild(canvas); } catch {}
    };
  }, []);

  // Debounce the rebuild: typing fires onChange per keystroke, and each rebuild
  // allocates/frees GPU geometry — rebuilding only after a ~200ms pause keeps the
  // driver from thrashing (and the live preview still feels instant).
  useEffect(() => {
    exprRef.current = expr;
    rangeRef.current = range;
    const t = setTimeout(() => rebuildRef.current(), 200);
    return () => clearTimeout(t);
  }, [expr, range]);

  // Capture exactly what's on screen (WYSIWYG) at higher resolution, save it into
  // the workspace images/ folder, and insert a figure referencing it. No Python.
  const insert = async () => {
    const scene = sceneRef.current, cam = cameraRef.current, renderer = rendererRef.current;
    if (!scene || !cam || !renderer) return;
    setSaving(true);
    try {
      // Capture at higher resolution by momentarily resizing the EXISTING renderer
      // (not a second WebGLRenderer — every extra context counts toward the browser's
      // ~16-context limit and, once exceeded, the oldest is force-lost and the GPU
      // process can crash). setSize(…, false) leaves the canvas CSS size untouched.
      const CW = 1600, CH = 1200;
      const prevSize = new THREE.Vector2();
      renderer.getSize(prevSize);
      const prevPixelRatio = renderer.getPixelRatio();
      const snapCam = cam.clone() as THREE.PerspectiveCamera;
      snapCam.aspect = CW / CH;
      snapCam.updateProjectionMatrix();
      renderer.setPixelRatio(1);
      renderer.setSize(CW, CH, false);
      renderer.render(scene, snapCam);
      const dataUrl = renderer.domElement.toDataURL('image/png');
      // Restore the on-screen size; the live loop resumes at the next frame.
      renderer.setPixelRatio(prevPixelRatio);
      renderer.setSize(prevSize.x, prevSize.y, false);

      const name = `images/surface3d-${Date.now().toString(36)}.png`;
      const res = await fetch(`${API}/workspace/save-image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: name, dataUrl })
      });
      if (!res.ok) { setErr('Could not save the image to the workspace.'); setSaving(false); return; }
      onSaved?.(name);
      const caption = expr.replace(/np\./g, '').replace(/\*\*/g, '^');
      onInsert(`\n#figure(\n  image("${name}", width: 80%),\n  caption: [3D surface: $z = ${caption}$],\n)\n\n`);
    } catch {
      setErr('Could not capture the plot.');
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '720px', height: '84vh' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>3D Plot Studio</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label className="form-field" style={{ flex: 2 }}><span>z = f(x, y) &nbsp;(numpy — use X, Y and np.*)</span>
              <input value={expr} onChange={e => setExpr(e.target.value)} placeholder="np.sin(np.sqrt(X**2 + Y**2))" />
            </label>
            <label className="form-field" style={{ maxWidth: 110 }}><span>Range ±</span>
              <input value={range} onChange={e => setRange(e.target.value)} />
            </label>
          </div>
          {err && <div className="form-hint" style={{ color: '#fca5a5' }}>{err}</div>}
          <div ref={mountRef} style={{ flex: 1, minHeight: 320, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-color)' }} />
          <div className="form-hint">Drag to rotate · scroll to zoom. “Insert this view” saves exactly what you see into <code>images/</code> and drops in the figure — no Python needed.</div>
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={insert} disabled={saving}>{saving ? 'Saving…' : 'Insert this view'}</button>
        </div>
      </div>
    </div>
  );
}
