// LaTeX tokens from the ink2latex model to Typst maths.
//
// The model writes only its own 243 tokens, so this handles exactly those: no
// general LaTeX parser is needed. Greek letters, sum, integral and the usual
// function names are written as their Typst names, common relations and arrows
// as Typst's shorthands, and other symbols as the Unicode character itself,
// which every Typst version reads the same way (Typst renames its symbol names
// between versions, and Hilbert uses whichever Typst is installed). Gives null
// when the input uses something this does not handle, so the caller can fall
// back to mitex. Checked by compiling every token in every argument position
// and the 5,423 formulas of the MathWriting test set.

const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu',
  'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'];

const FUNCTION_NAMES = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'lim', 'sin', 'cos', 'tan', 'cot', 'sec',
  'csc', 'log', 'exp', 'max', 'min', 'det', 'sup', 'inf', 'ln'];

// Written by name: stable across Typst versions.
const NAMED: Record<string, string> = {
  ...Object.fromEntries(GREEK.map(g => [`\\${g}`, g])),
  ...Object.fromEntries(FUNCTION_NAMES.map(f => [`\\${f}`, f])),
  '\\epsilon': 'epsilon.alt', '\\phi': 'phi.alt', '\\varphi': 'phi', '\\vartheta': 'theta.alt',
  '\\varpi': 'pi.alt', '\\varsigma': 'sigma.alt',
  '\\sum': 'sum', '\\prod': 'product', '\\int': 'integral', '\\infty': 'infinity',
  '\\partial': 'partial', '\\nabla': 'nabla',
};

// Typst's own shorthands, which every version reads: easier to read and edit.
const SHORT: Record<string, string> = {
  '\\le': '<=', '\\leq': '<=', '\\ge': '>=', '\\geq': '>=', '\\ne': '!=', '\\neq': '!=',
  '\\rightarrow': '->', '\\leftarrow': '<-', '\\leftrightarrow': '<->', '\\Rightarrow': '=>', '\\Leftrightarrow': '<=>',
  '\\mapsto': '|->', '\\longrightarrow': '-->', '\\iff': '<==>', '\\gg': '>>', '\\ll': '<<',
};

// Written as the character.
const CHAR: Record<string, string> = {
  '\\Vdash': '⊩', '\\aleph': 'ℵ', '\\angle': '∠',
  '\\approx': '≈', '\\backslash': '∖', '\\bigcap': '⋂', '\\bigcup': '⋃', '\\bigoplus': '⨁',
  '\\bigvee': '⋁', '\\bigwedge': '⋀', '\\bullet': '•', '\\cap': '∩', '\\cdot': '⋅', '\\circ': '∘',
  '\\cong': '≅', '\\cup': '∪', '\\dagger': '†', '\\degree': '°', '\\div': '÷', '\\emptyset': '∅',
  '\\equiv': '≡', '\\exists': '∃', '\\forall': '∀',
  '\\hbar': 'ℏ', '\\hookrightarrow': '↪', '\\iint': '∬', '\\in': '∈', '\\langle': '⟨',
  '\\lceil': '⌈', '\\lfloor': '⌊', '\\models': '⊨', '\\mp': '∓',
  '\\neg': '¬', '\\ni': '∋', '\\notin': '∉', '\\odot': '⊙', '\\oint': '∮', '\\ominus': '⊖',
  '\\oplus': '⊕', '\\otimes': '⊗', '\\perp': '⊥', '\\pm': '±', '\\prime': '′', '\\propto': '∝',
  '\\rangle': '⟩', '\\rceil': '⌉', '\\rfloor': '⌋', '\\rightleftharpoons': '⇌',
  '\\sim': '∼', '\\simeq': '≃', '\\subset': '⊂', '\\subseteq': '⊆', '\\subsetneq': '⊊', '\\supset': '⊃',
  '\\supseteq': '⊇', '\\times': '×', '\\top': '⊤', '\\triangle': '△', '\\triangleq': '≜', '\\vdash': '⊢',
  '\\vdots': '⋮', '\\vee': '∨', '\\wedge': '∧', '\\|': '‖', '\\{': '{', '\\}': '}',
};

// Characters that mean something else in Typst maths.
const ESCAPE: Record<string, string> = {
  '/': '\\/', '#': '\\#', '\\#': '\\#', '$': '\\$', '%': '%', '\\%': '%', '&': '\\&', '\\&': '\\&',
  '*': '\\*', '_': '\\_', '^': '\\^', '"': '\\"', '@': '\\@', '`': '\\`', '~': '\\~', '\\': '\\\\',
};

const ACCENT: Record<string, string> = {
  '\\hat': 'hat', '\\vec': 'arrow', '\\dot': 'dot', '\\tilde': 'tilde', '\\overline': 'overline',
  '\\underline': 'underline', '\\mathbb': 'bb',
};

const ENV: Record<string, string> = {
  matrix: 'mat(delim: #none, ', pmatrix: 'mat(', bmatrix: 'mat(delim: "[", ', Bmatrix: 'mat(delim: "{", ',
  vmatrix: 'mat(delim: "|", ', Vmatrix: 'mat(delim: "||", ', cases: 'cases(',
};
const LINES_ENV = new Set(['aligned', 'gathered', 'array', 'align', 'split', 'eqnarray']);

class Unsupported extends Error {}

type Node =
  | { kind: 'atom'; t: string }
  | { kind: 'group'; body: Node[] }
  | { kind: 'frac'; num: Node; den: Node }
  | { kind: 'sqrt'; index: Node[] | null; body: Node }
  | { kind: 'accent'; name: string; body: Node }
  | { kind: 'script'; base: Node | null; sub: Node | null; sup: Node | null }
  | { kind: 'env'; name: string; rows: Node[][][] };

// Tokens to a tree.
function parse(tokens: string[]): Node[] {
  let i = 0;
  const peek = () => tokens[i];
  function argument(): Node {
    if (peek() === '{') { i++; const body = sequence('}'); if (peek() === '}') i++; return { kind: 'group', body }; }
    if (i >= tokens.length) return { kind: 'group', body: [] };
    return single();
  }
  function single(): Node {
    const t = tokens[i++];
    if (t === '{') { const body = sequence('}'); if (peek() === '}') i++; return { kind: 'group', body }; }
    if (t === '\\frac') return { kind: 'frac', num: argument(), den: argument() };
    if (t === '\\sqrt') {
      let index: Node[] | null = null;
      if (peek() === '[') { i++; index = sequence(']'); if (peek() === ']') i++; }
      return { kind: 'sqrt', index, body: argument() };
    }
    if (ACCENT[t]) return { kind: 'accent', name: ACCENT[t], body: argument() };
    if (t === '\\begin') {
      if (peek() !== '{') throw new Unsupported('\\begin without a name');
      i++; let name = ''; while (i < tokens.length && peek() !== '}') name += tokens[i++]; i++;
      const rows: Node[][][] = [[[]]];
      while (i < tokens.length && peek() !== '\\end') {
        if (peek() === '&') { i++; rows[rows.length - 1].push([]); continue; }
        if (peek() === '\\\\') { i++; rows.push([[]]); continue; }
        const row = rows[rows.length - 1];
        row[row.length - 1].push(...sequence(null, true));
      }
      if (peek() === '\\end') { i++; if (peek() === '{') { while (i < tokens.length && peek() !== '}') i++; i++; } }
      return { kind: 'env', name, rows: rows.filter((r, k) => k < rows.length - 1 || r.some(c => c.length)) };
    }
    if (t === '\\end') throw new Unsupported('\\end without \\begin');
    return { kind: 'atom', t };
  }
  // A run of nodes, with ^ and _ attached to the node before them.
  function sequence(close: string | null, inEnv = false): Node[] {
    const out: Node[] = [];
    while (i < tokens.length && peek() !== close) {
      if (inEnv && (peek() === '&' || peek() === '\\\\' || peek() === '\\end')) break;
      if (!inEnv && close === null && peek() === '\\end') break;
      const t = peek();
      if (t === '^' || t === '_') {
        i++;
        const key = t === '^' ? 'sup' : 'sub';
        const last = out[out.length - 1];
        let node: Extract<Node, { kind: 'script' }>;
        if (last && last.kind === 'script' && !last[key]) { out.pop(); node = last; }
        else if (last && last.kind !== 'script') { out.pop(); node = { kind: 'script', base: last, sub: null, sup: null }; }
        else node = { kind: 'script', base: null, sub: null, sup: null };
        node[key] = argument();
        out.push(node);
        continue;
      }
      if (close && (t === '}' || t === ']') && t !== close) { i++; out.push({ kind: 'atom', t }); continue; }
      out.push(single());
    }
    return out;
  }
  const body = sequence(null);
  if (i < tokens.length) throw new Unsupported(`stopped at ${tokens[i]}`);
  return body;
}

// Inside a function's argument Typst wants every bracket closed, where at the
// top level it forgives an open one. Handwriting read wrongly can leave one
// open or closed alone, so those are escaped and shown as plain characters.
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '⟨': '⟩', '⌈': '⌉', '⌊': '⌋' };
const CLOSERS = new Set(Object.values(PAIRS));
function closeArgument(text: string): string {
  const chars = [...text], stack: number[] = [], lone = new Set<number>();
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\\') { i++; continue; }
    if (c === '"') { while (++i < chars.length && chars[i] !== '"') if (chars[i] === '\\') i++; continue; }
    if (PAIRS[c]) stack.push(i);
    else if (CLOSERS.has(c)) {
      if (stack.length && PAIRS[chars[stack[stack.length - 1]]] === c) stack.pop();
      else lone.add(i);
    }
  }
  for (const i of stack) lone.add(i);
  return chars.map((c, i) => (lone.has(i) ? '\\' + c : c)).join('');
}

// A tree to Typst. `arg` is set inside a function's argument, where a bare
// comma or semicolon would end the argument.
function emit(nodes: Node[], arg = false): string {
  const parts: string[] = [];
  for (const n of nodes) {
    const text = node(n, arg);
    if (text === '') continue;
    const prev = parts[parts.length - 1];
    // Digits of one number stay together; everything else gets a space, so
    // letters never run into one identifier (xy is one unknown name in Typst).
    if (prev !== undefined && /[0-9.]$/.test(prev) && /^[0-9]/.test(text) && n.kind === 'atom') parts[parts.length - 1] = prev + text;
    else parts.push(text);
  }
  const text = parts.join(' ');
  return arg ? closeArgument(text) : text;
}

const inner = (n: Node) => (n.kind === 'group' ? n.body : [n]);

function node(n: Node, arg: boolean): string {
  switch (n.kind) {
    case 'atom': return atom(n.t, arg);
    case 'group': return n.body.length ? emit(n.body, arg) : '';
    case 'frac': return `frac(${emit(inner(n.num), true) || '""'}, ${emit(inner(n.den), true) || '""'})`;
    case 'sqrt': {
      const body = emit(inner(n.body), true) || '""';
      return n.index && n.index.length ? `root(${emit(n.index, true)}, ${body})` : `sqrt(${body})`;
    }
    case 'accent': return `${n.name}(${emit(inner(n.body), true) || '""'})`;
    case 'script': {
      const base = n.base ? node(n.base, arg) : '""';
      const wrap = (s: Node) => {
        const text = s.kind === 'group' ? emit(s.body, true) : node(s, true);
        return /^[A-Za-z0-9]$|^[0-9]+$|^[^\sA-Za-z0-9(),;\\"]$/u.test(text) ? text : `(${text})`;
      };
      // A base that is itself a longer expression keeps its own brackets.
      const b = n.base && n.base.kind === 'group' && n.base.body.length > 1 ? `(${base})` : base;
      return b + (n.sub ? `_${wrap(n.sub)}` : '') + (n.sup ? `^${wrap(n.sup)}` : '');
    }
    case 'env': {
      if (LINES_ENV.has(n.name)) return n.rows.map(r => r.map(c => emit(c)).join(' & ')).join(' \\ ');
      const open = ENV[n.name];
      if (!open) throw new Unsupported(`environment ${n.name}`);
      if (n.name === 'cases') return `${open}${n.rows.map(r => r.map(c => emit(c, true)).join(' & ')).join(', ')})`;
      return `${open}${n.rows.map(r => r.map(c => emit(c, true) || '""').join(', ')).join('; ')})`;
    }
  }
}

function atom(t: string, arg: boolean): string {
  if (/^[A-Za-z]$/.test(t) || /^[0-9]$/.test(t)) return t;
  if (NAMED[t]) return NAMED[t];
  if (SHORT[t]) return SHORT[t];
  if (CHAR[t]) return CHAR[t];
  if (t === ',' || t === ';') return arg ? `\\${t}` : t;
  if (t in ESCAPE) return ESCAPE[t];
  if (t.length === 1 && '+-=<>!?:.()[]|\''.includes(t)) return t;
  // A line break means nothing inside an argument, and would escape what follows.
  if (t === '\\\\') return arg ? '' : '\\';
  throw new Unsupported(`token ${t}`);
}

// The model spells function names letter by letter; join them back into the
// command (as the ink2latex demo does), unless the letters are part of a longer word.
export function tidy(tokens: string[]): string[] {
  const out: string[] = [], letter = (k: number) => k >= 0 && k < tokens.length && /^[A-Za-z]$/.test(tokens[k]);
  for (let i = 0; i < tokens.length;) {
    const name = FUNCTION_NAMES.find(n => n.split('').every((c, j) => tokens[i + j] === c) && !letter(i - 1));
    if (name) { out.push('\\' + name); i += name.length; } else out.push(tokens[i++]);
  }
  return out;
}

// The same tokens as one LaTeX string, for the mitex fallback.
export function toLatex(tokens: string[]): string {
  let out = '';
  for (const token of tidy(tokens)) {
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(token)) out += ' ';
    out += token;
  }
  return out;
}

// Tokens to Typst maths, or null.
export function tokensToTypst(tokens: string[]): string | null {
  const list = tidy(tokens);
  if (!list.length) return '';
  try {
    return emit(parse(list));
  } catch (error) {
    if (error instanceof Unsupported) return null;
    throw error;
  }
}

// One token on its own (a single symbol), or null when it is not one.
export function symbolToTypst(token: string): string | null {
  if (token.length > 1 && !token.startsWith('\\')) return null;
  if (ACCENT[token] || ['\\frac', '\\sqrt', '\\begin', '\\end', '\\\\', '{', '}', '^', '_', '&'].includes(token)) return null;
  try { return atom(token, false); } catch { return null; }
}

// The character a single token stands for, to show on a button.
const GREEK_GLYPH: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', chi: 'χ',
  psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', varepsilon: 'ε', varphi: 'φ', vartheta: 'ϑ', varpi: 'ϖ', varsigma: 'ς',
};
const OTHER_GLYPH: Record<string, string> = {
  '\\sum': '∑', '\\prod': '∏', '\\int': '∫', '\\infty': '∞', '\\partial': '∂', '\\nabla': '∇',
  '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥', '\\ne': '≠', '\\neq': '≠', '\\rightarrow': '→', '\\leftarrow': '←',
  '\\leftrightarrow': '↔', '\\Rightarrow': '⇒', '\\Leftrightarrow': '⇔', '\\mapsto': '↦', '\\longrightarrow': '⟶',
  '\\iff': '⟺', '\\gg': '≫', '\\ll': '≪',
};
export function symbolGlyph(token: string): string {
  const bare = token.replace(/^\\/, '');
  if (token.startsWith('\\') && GREEK_GLYPH[bare]) return GREEK_GLYPH[bare];
  if (OTHER_GLYPH[token]) return OTHER_GLYPH[token];
  if (CHAR[token]) return CHAR[token];
  if (token.startsWith('\\') && FUNCTION_NAMES.includes(bare)) return bare;
  return token.replace(/^\\(?=[^A-Za-z])/, '');
}
