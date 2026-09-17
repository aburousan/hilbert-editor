// One parser for the expressions typed into the Plot Studio, with two ways out:
// a JavaScript function that draws the interactive canvas, and Typst code that
// goes into the document. The picture on screen and the plot in the PDF come
// from the same reading of the text, so they cannot disagree about what `x^2`
// or `log(x)` means.
//
// The syntax is the one people already type — `sin(x)`, `x^2`, `2x` — and
// Typst's own `calc.sin(x)` is accepted too, so expressions written before this
// existed still work.

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'const'; name: keyof typeof CONSTANTS }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node };

const CONSTANTS = {
  pi: { js: Math.PI, typst: 'calc.pi' },
  tau: { js: Math.PI * 2, typst: 'calc.tau' },
  e: { js: Math.E, typst: 'calc.e' },
} as const;

// name → how many arguments, what JavaScript does, and how Typst writes it.
// `typstCall` is there for the few that do not line up: Typst's inverse trig
// returns an angle rather than a number, and its logarithm takes its base as a
// named argument.
type Fn = { args: number[]; js: (...a: number[]) => number; typst: string; typstCall?: (args: string[]) => string };
const FUNCTIONS: Record<string, Fn> = {
  sin: { args: [1], js: Math.sin, typst: 'calc.sin' },
  cos: { args: [1], js: Math.cos, typst: 'calc.cos' },
  tan: { args: [1], js: Math.tan, typst: 'calc.tan' },
  // An angle in Typst; `.rad()` turns it back into the number a plot wants.
  asin: { args: [1], js: Math.asin, typst: 'calc.asin', typstCall: a => `calc.asin(${a[0]}).rad()` },
  acos: { args: [1], js: Math.acos, typst: 'calc.acos', typstCall: a => `calc.acos(${a[0]}).rad()` },
  atan: { args: [1], js: Math.atan, typst: 'calc.atan', typstCall: a => `calc.atan(${a[0]}).rad()` },
  atan2: { args: [2], js: (y, x) => Math.atan2(y, x), typst: 'calc.atan2', typstCall: a => `calc.atan2(${a[1]}, ${a[0]}).rad()` },
  sinh: { args: [1], js: Math.sinh, typst: 'calc.sinh' },
  cosh: { args: [1], js: Math.cosh, typst: 'calc.cosh' },
  tanh: { args: [1], js: Math.tanh, typst: 'calc.tanh' },
  exp: { args: [1], js: Math.exp, typst: 'calc.exp' },
  ln: { args: [1], js: Math.log, typst: 'calc.ln' },
  // Same split as everywhere else in mathematics teaching: log is base ten,
  // ln is natural. Typst agrees.
  log: {
    args: [1, 2],
    js: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
    typst: 'calc.log',
    typstCall: a => (a.length === 1 ? `calc.log(${a[0]})` : `calc.log(${a[0]}, base: ${a[1]})`),
  },
  sqrt: { args: [1], js: Math.sqrt, typst: 'calc.sqrt' },
  abs: { args: [1], js: Math.abs, typst: 'calc.abs' },
  floor: { args: [1], js: Math.floor, typst: 'calc.floor' },
  ceil: { args: [1], js: Math.ceil, typst: 'calc.ceil' },
  // Typst rounds a half away from zero; JavaScript rounds it up. Following
  // Typst keeps the drawing and the figure identical.
  round: { args: [1], js: x => Math.sign(x) * Math.round(Math.abs(x)), typst: 'calc.round' },
  pow: { args: [2], js: Math.pow, typst: 'calc.pow' },
  min: { args: [2, 3, 4], js: Math.min, typst: 'calc.min' },
  max: { args: [2, 3, 4], js: Math.max, typst: 'calc.max' },
  rem: { args: [2], js: (a, b) => a % b, typst: 'calc.rem' },
};

type Token = { k: 'num'; v: number } | { k: 'name'; v: string } | { k: 'op'; v: string };

const tokenize = (src: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?/i.exec(src.slice(i));
      if (!m) throw new Error(`I cannot read the number at position ${i + 1}.`);
      const value = parseFloat(m[0]);
      if (!Number.isFinite(value)) throw new Error(`“${m[0]}” is too big to be a number.`);
      // `1.2.3` is a typing slip, not a multiplication.
      if (src[i + m[0].length] === '.') throw new Error(`“${m[0]}.” has one decimal point too many.`);
      out.push({ k: 'num', v: value });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      // `calc.sin` counts as one name, so Typst's own spelling parses too.
      const m = /^[A-Za-z_][A-Za-z_0-9]*(\.[A-Za-z_][A-Za-z_0-9]*)*/.exec(src.slice(i))!;
      out.push({ k: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
    throw new Error(`“${c}” does not belong in an expression.`);
  }
  return out;
};

/** Parses an expression over the given variables, e.g. ['x'] or ['t']. */
export const parseExpr = (src: string, vars: string[]): { ok: true; ast: Node } | { ok: false; error: string } => {
  let tokens: Token[];
  try { tokens = tokenize(src); } catch (e: any) { return { ok: false, error: e.message }; }
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (v: string) => { const t = peek(); return t && t.k === 'op' && t.v === v; };
  const eat = (v: string) => { if (!isOp(v)) throw new Error(`I expected “${v}” here.`); at++; };

  const expression = (): Node => {
    let node = term();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[at] as any).v as '+' | '-';
      at++;
      node = { t: 'bin', op, a: node, b: term() };
    }
    return node;
  };
  const term = (): Node => {
    let node = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = (tokens[at] as any).v as '*' | '/';
        at++;
        node = { t: 'bin', op, a: node, b: unary() };
        continue;
      }
      // `2x`, `3(x + 1)`, `2sin(x)`: a number or a bracket straight after a
      // value means multiplication, the way it is written on paper.
      const t = peek();
      if (t && (t.k === 'num' || t.k === 'name' || (t.k === 'op' && t.v === '('))) {
        node = { t: 'bin', op: '*', a: node, b: unary() };
        continue;
      }
      return node;
    }
  };
  const unary = (): Node => {
    if (isOp('-')) { at++; return { t: 'neg', a: unary() }; }
    if (isOp('+')) { at++; return unary(); }
    return power();
  };
  const power = (): Node => {
    const base = atom();
    if (isOp('^')) { at++; return { t: 'bin', op: '^', a: base, b: unary() }; }
    return base;
  };
  const atom = (): Node => {
    const t = peek();
    if (!t) throw new Error('The expression stops early.');
    if (t.k === 'num') { at++; return { t: 'num', v: t.v }; }
    if (t.k === 'op' && t.v === '(') { at++; const inner = expression(); eat(')'); return inner; }
    if (t.k === 'name') {
      at++;
      const raw = t.v;
      const name = raw.replace(/^calc\./, '');
      // `x(x + 1)` and `pi(x + 1)` are products; only a function name in front
      // of a bracket is a call.
      if (vars.includes(raw)) return { t: 'var', name: raw };
      if (name in CONSTANTS && !(name in FUNCTIONS)) return { t: 'const', name: name as keyof typeof CONSTANTS };
      if (isOp('(')) {
        at++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(expression());
          while (isOp(',')) { at++; args.push(expression()); }
        }
        eat(')');
        const fn = FUNCTIONS[name];
        if (!fn) throw new Error(`I do not know the function “${raw}”.`);
        if (!fn.args.includes(args.length)) {
          throw new Error(`“${name}” takes ${fn.args.join(' or ')} argument${fn.args[0] === 1 && fn.args.length === 1 ? '' : 's'}.`);
        }
        return { t: 'call', name, args };
      }
      if (vars.includes(raw)) return { t: 'var', name: raw };
      if (name in CONSTANTS) return { t: 'const', name: name as keyof typeof CONSTANTS };
      throw new Error(`I do not know “${raw}”. The variable here is ${vars.map(v => `“${v}”`).join(' or ')}.`);
    }
    throw new Error(`“${(t as any).v}” does not belong here.`);
  };

  try {
    const ast = expression();
    if (at !== tokens.length) throw new Error('There is something left over at the end.');
    return { ok: true, ast };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
};

/** Typst source for the expression, using calc.* throughout. */
export const toTypst = (n: Node): string => {
  switch (n.t) {
    case 'num': return String(n.v);
    case 'var': return n.name;
    case 'const': return CONSTANTS[n.name].typst;
    case 'neg': return `-(${toTypst(n.a)})`;
    case 'call': {
      const fn = FUNCTIONS[n.name];
      const args = n.args.map(toTypst);
      return fn.typstCall ? fn.typstCall(args) : `${fn.typst}(${args.join(', ')})`;
    }
    case 'bin':
      // Typst's code has no power operator, so every `^` becomes calc.pow.
      if (n.op === '^') return `calc.pow(${toTypst(n.a)}, ${toTypst(n.b)})`;
      return `(${toTypst(n.a)} ${n.op} ${toTypst(n.b)})`;
  }
};

/** The same expression as a function of its variables, for drawing on screen. */
export const toFunction = (n: Node, vars: string[]): ((...values: number[]) => number) => {
  const walk = (node: Node, values: number[]): number => {
    switch (node.t) {
      case 'num': return node.v;
      case 'var': return values[vars.indexOf(node.name)];
      case 'const': return CONSTANTS[node.name].js;
      case 'neg': return -walk(node.a, values);
      case 'call': return FUNCTIONS[node.name].js(...node.args.map(a => walk(a, values)));
      case 'bin': {
        const a = walk(node.a, values);
        const b = walk(node.b, values);
        switch (node.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '^': return Math.pow(a, b);
        }
      }
    }
  };
  return (...values: number[]) => walk(n, values);
};

/** Both forms at once, or the reason the expression could not be read. */
export const compileExpr = (src: string, vars: string[]) => {
  const parsed = parseExpr(src, vars);
  if (!parsed.ok) return { ok: false as const, error: parsed.error };
  return { ok: true as const, typst: toTypst(parsed.ast), fn: toFunction(parsed.ast, vars) };
};
