import { useMemo, useState } from 'react';
import type { EqTemplate } from './EquationGallery';

// Ready-made snippets for the physica package (dv, pdv, tensors, bra-ket,
// isotopes, Taylor terms, rotation matrices, transpose/dagger…). Every item
// pulls in the physica import on insert and drops in with Tab-through blanks.

const CATEGORIES: { name: string; items: EqTemplate[] }[] = [
  {
    name: 'Derivatives',
    items: [
      { name: 'Derivative  dy/dx', snippet: 'dv(${1:y}, ${2:x})', physica: true },
      { name: 'Second derivative', snippet: 'dv(${1:y}, ${2:x}, 2)', physica: true },
      { name: 'nth derivative', snippet: 'dv(${1:f}, ${2:x}, ${3:n})', physica: true },
      { name: 'Derivative operator', snippet: 'dv(, ${1:x})', physica: true },
      { name: 'Large style', snippet: 'dv(${1:f}, ${2:x}, style: "large")', physica: true },
      { name: 'Material derivative  D/Dt', snippet: 'dv(${1:vb(u)}, t, d: upright(D))', physica: true },
    ],
  },
  {
    name: 'Partial derivatives',
    items: [
      { name: 'Partial  ∂f/∂x', snippet: 'pdv(${1:f}, ${2:x})', physica: true },
      { name: 'Second partial', snippet: 'pdv(${1:f}, ${2:x}, 2)', physica: true },
      { name: 'Mixed  ∂²f/∂x∂y', snippet: 'pdv(${1:f}, ${2:x}, ${3:y})', physica: true },
      { name: 'Mixed orders', snippet: 'pdv(${1:f}, ${2:x}, ${3:y}, [${4:2}, ${5:1}])', physica: true },
      { name: 'Functional  δS/δφ', snippet: 'pdv(${1:S}, ${2:phi}, d: delta)', physica: true },
    ],
  },
  {
    name: 'Vector calculus',
    items: [
      { name: 'Gradient', snippet: 'grad ${1:phi}', physica: true },
      { name: 'Divergence', snippet: 'div ${1:vb(F)}', physica: true },
      { name: 'Curl', snippet: 'curl ${1:vb(F)}', physica: true },
      { name: 'Laplacian', snippet: 'laplacian ${1:phi}', physica: true },
      { name: 'Bold vector', snippet: 'vb(${1:F})', physica: true },
      { name: 'Unit vector', snippet: 'vu(${1:n})', physica: true },
    ],
  },
  {
    name: 'Bra–ket',
    items: [
      { name: 'Bra', snippet: 'bra(${1:psi})', physica: true },
      { name: 'Ket', snippet: 'ket(${1:psi})', physica: true },
      { name: 'Braket ⟨φ|ψ⟩', snippet: 'braket(${1:phi}, ${2:psi})', physica: true },
      { name: 'Ketbra |ψ⟩⟨φ|', snippet: 'ketbra(${1:psi}, ${2:phi})', physica: true },
      { name: 'Expectation value', snippet: 'expval(${1:hat(A)})', physica: true },
      { name: 'Matrix element', snippet: 'mel(${1:phi}, ${2:hat(A)}, ${3:psi})', physica: true },
    ],
  },
  {
    name: 'Tensors',
    items: [
      { name: 'Upper index', snippet: 'tensor(${1:T}, +${2:mu})', physica: true },
      { name: 'Mixed indices', snippet: 'tensor(${1:T}, +${2:mu}, -${3:nu})', physica: true },
      { name: 'Metric  g_μν', snippet: 'tensor(g, -${1:mu}, -${2:nu})', physica: true },
      { name: 'Christoffel symbol', snippet: 'tensor(Gamma, +${1:nu}, -${2:mu}, -${3:lambda})', physica: true },
      { name: 'Covariant derivative', snippet: 'grad_${1:mu} ${2:A}^${3:nu} = partial_${1:mu} ${2:A}^${3:nu} + tensor(Gamma, +${3:nu}, -${1:mu}, -lambda) ${2:A}^lambda', physica: true },
    ],
  },
  {
    name: 'Matrices',
    items: [
      { name: '2×2 matrix', snippet: 'mat(${1:a}, ${2:b}; ${3:c}, ${4:d})', physica: true },
      { name: 'Column vector', snippet: 'vec(${1:a}, ${2:b}, ${3:c})', physica: true },
      { name: 'Rotation 2D', snippet: 'rot2mat(${1:theta})', physica: true },
      { name: 'Rotation 3D (x-axis)', snippet: 'rot3xmat(${1:theta})', physica: true },
      { name: 'Rotation 3D (z-axis)', snippet: 'rot3zmat(${1:theta})', physica: true },
      { name: 'Gram matrix', snippet: 'grammat(${1:v_1}, ${2:v_2}, ${3:v_3})', physica: true },
    ],
  },
  {
    name: 'Isotopes & nuclei',
    items: [
      { name: 'Isotope  ¹⁴₆C', snippet: 'isotope(${1:"C"}, a: ${2:14}, z: ${3:6})', physica: true },
      { name: 'Element by Z', snippet: 'isotope(${1:"Fe"}, z: ${2:26})', physica: true },
      { name: 'Alpha decay', snippet: 'isotope(${1:"U"}, a: ${2:238}, z: ${3:92}) -> isotope(${4:"Th"}, a: ${5:234}, z: ${6:90}) + isotope("He", a: 4, z: 2)', physica: true },
      { name: 'Beta decay', snippet: 'isotope(${1:"C"}, a: ${2:14}, z: ${3:6}) -> isotope(${4:"N"}, a: ${5:14}, z: ${6:7}) + isotope(e, a: 0, z: -1)', physica: true },
    ],
  },
  {
    name: 'Series & operators',
    items: [
      { name: 'Taylor term', snippet: 'taylorterm(${1:f}, ${2:x}, ${3:x_0}, ${4:n})', physica: true },
      { name: 'Transpose  Aᵀ', snippet: '${1:A}^T', physica: true },
      { name: 'Dagger  A†', snippet: '${1:A}^dagger', physica: true },
      { name: 'Absolute value', snippet: 'abs(${1:x})', physica: true },
      { name: 'Norm', snippet: 'norm(${1:v})', physica: true },
      { name: 'Evaluated at bounds', snippet: 'evaluated(${1:F(t)})_${2:0}^${3:T}', physica: true },
      { name: 'Order  O(x²)', snippet: 'order(${1:x^2})', physica: true },
    ],
  },
];

const ALL = CATEGORIES.flatMap(c => c.items.map(it => ({ ...it, cat: c.name })));
const plain = (s: string) => s.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '□');

export default function PhysicsGallery({ onClose, onInsert }: {
  onClose: () => void,
  onInsert: (t: EqTemplate, display: boolean) => void,
}) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('All');
  const [display, setDisplay] = useState(true);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = cat === 'All' ? ALL : ALL.filter(i => i.cat === cat);
    if (q) list = list.filter(i => i.name.toLowerCase().includes(q) || plain(i.snippet).toLowerCase().includes(q));
    return list;
  }, [query, cat]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content eq-gallery" style={{ width: '860px', maxWidth: '95vw', height: '78vh' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Insert Physics <span style={{ fontWeight: 400, fontSize: '0.8rem', opacity: 0.6 }}>· physica package</span></h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="eq-gallery-toolbar">
          <input autoFocus className="eq-gallery-search" placeholder="Search physics… (tensor, isotope, bra-ket, rotation)" value={query} onChange={e => setQuery(e.target.value)} />
          <label className="eq-gallery-display" title="Insert as a centred display equation, or inline">
            <input type="checkbox" checked={display} onChange={e => setDisplay(e.target.checked)} /> Display
          </label>
        </div>

        <div className="eq-gallery-body">
          <div className="eq-gallery-cats">
            {['All', ...CATEGORIES.map(c => c.name)].map(c => (
              <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
          <div className="eq-gallery-grid">
            {items.length === 0 && <div className="eq-gallery-empty">Nothing matches “{query}”.</div>}
            {items.map((it, i) => (
              <button key={i} className="eq-card" onClick={() => onInsert(it, display)} title="Insert this snippet">
                <span className="eq-card-name">{it.name}</span>
                <code className="eq-card-code">{plain(it.snippet)}</code>
              </button>
            ))}
          </div>
        </div>

        <div className="eq-gallery-foot">
          Everything here uses the <code>physica</code> package — the import is added automatically. Press <b>Tab</b> to jump between the blanks after inserting.
        </div>
      </div>
    </div>
  );
}
