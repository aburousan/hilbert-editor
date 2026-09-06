// What a right-to-left line actually looks like once the browser has laid it
// out. The direction rules live in three places that only meet at runtime — the
// scanner in textDirection.ts, the decorations App.tsx builds from it, and the
// bidi rules in index.css — so the only way to know a Hebrew line came out
// right is to render it in a real editor and measure where every character
// landed. That is what this does: real Monaco, the app's own stylesheet, the
// app's own scanner, and a character-by-character read of the result.
//
// Each case names the visual order it expects, written left to right as the
// screen shows it. A Hebrew word therefore appears reversed in the expectation,
// which is the point: it is a picture of the line, not the line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const transpiled = ts.transpileModule(fs.readFileSync(path.join(root, 'src/textDirection.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;
const loaded = { exports: {} };
Function('exports', 'module', 'require', transpiled)(loaded.exports, loaded, () => {
  throw new Error('textDirection.ts unexpectedly imported another module');
});
const { HAS_RTL, blockAfter, lineDirection, segmentLine } = loaded.exports;

// Only the bidi rules, so a change anywhere else in the stylesheet cannot make
// this pass or fail for the wrong reason.
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');
const bidiCss = css.slice(css.indexOf('/* Monaco stamps')).split('/* brief flash')[0];
assert.match(bidiCss, /unicode-bidi/, 'the bidi rules moved out of index.css');

const cases = [
  {
    name: 'Arabic digits do not make English prose right-to-left',
    source: '\u0661\u0662\u0663 English text',
    visual: ['\u0661\u0662\u0663 English text'],
    aligned: 'left',
  },
  {
    name: 'Persian digits do not make English prose right-to-left',
    source: '\u06f1\u06f2\u06f3 English text',
    visual: ['\u06f1\u06f2\u06f3 English text'],
    aligned: 'left',
  },
  {
    name: 'a Hebrew line starts at the right edge',
    source: 'שלום עולם',
    visual: ['םלוע םולש'],
    aligned: 'right',
  },
  {
    name: 'heading and list markers sit at the start of the text, which is the right',
    source: '= שלום עולם\n+ שלום שלום\n- מה שלום כולם',
    visual: ['םלוע םולש =', 'םולש םולש +', 'םלוכ םולש המ -'],
  },
  {
    name: 'inline maths keeps its delimiters',
    source: 'ידוע ש- $1+1=2$ כמובן.',
    visual: ['.ןבומכ $1+1=2$ -ש עודי'],
  },
  {
    name: 'a call, a raw span and a content block in one Hebrew line',
    source: 'קוד: #emph[שלום] וגם `raw code` בסוף',
    visual: ['ףוסב `raw code` םגו ]םולש[#emph :דוק'],
  },
  {
    name: 'an English line with one Hebrew word in it stays left to right',
    source: 'The word שלום inside an English line with $x^2$ maths.',
    visual: ['The word םולש inside an English line with $x^2$ maths.'],
    aligned: 'left',
  },
  {
    name: 'Arabic with a formula',
    source: 'مرحبا بالعالم $E = m c^2$ نهاية',
    visual: ['ةياهن $E = m c^2$ ملاعلاب ابحرم'],
  },
  {
    name: 'a code line with a Hebrew argument stays a code line',
    source: '#figure(image("a.png"), caption: [כיתוב בעברית])',
    visual: ['#figure(image("a.png"), caption: [תירבעב בותיכ])'],
    aligned: 'left',
  },
  {
    name: 'quotes and escapes inside Hebrew',
    source: 'התשפ\\"ו',
    visual: ['ו"\\פשתה'],
  },
  {
    name: 'forced right-to-left leaves a Latin code line readable',
    source: '#set page(paper: "a4")',
    forced: 'rtl',
    visual: ['#set page(paper: "a4")'],
    aligned: 'right',
  },
  {
    name: 'forced right-to-left keeps a formula the right way round',
    source: 'A formula $a + b = c$ here',
    forced: 'rtl',
    visual: ['A formula $a + b = c$ here'],
    aligned: 'right',
  },
  {
    // Monaco's default is to swap an invisible character for a visible
    // `[U+2066]` box, which takes it out of the line and so stops it working.
    // Without the isolate the two Latin words swap: `USD 123`.
    name: 'a left-to-right isolate holds a Latin phrase together in Hebrew',
    source: 'שלום \u2066123 USD\u2069 עולם',
    visual: ['םלוע 123 USD םולש'],
  },
  {
    name: 'a Hebrew string inside a code block does not turn the block round',
    source: '```python\nprint("שלום")\n```',
    visual: ['```python', 'print("םולש")', '```'],
    aligned: 'left',
  },
  {
    name: 'a display formula keeps its own direction across lines',
    source: '$\n  "טקסט" + x\n$',
    visual: ['$', '  "טסקט" + x', '$'],
    aligned: 'left',
  },
  {
    // Two of these next to each other are where holding a stretch together by
    // styling it stops being enough: as embedded runs they merge and come out
    // in the wrong order, `@sec:intro <sec:intro>`.
    name: 'a reference and a label side by side keep their own order',
    source: 'ראו @sec:intro <sec:intro> בסוף',
    visual: ['ףוסב <sec:intro> @sec:intro ואר'],
  },
  {
    name: 'two formulas side by side keep their own order',
    source: 'ראו $a$ $b$ בסוף',
    visual: ['ףוסב $b$ $a$ ואר'],
  },
  {
    name: 'a set rule above Hebrew prose is left to right',
    source: '#set text(lang: "he")\nשלום עולם',
    visual: ['#set text(lang: "he")', 'םלוע םולש'],
  },
];

// The plan App.tsx builds: one direction decoration per right-to-left line, one
// isolating decoration per stretch the scanner calls code. Kept in step with
// the loop in App.tsx by hand — there is no way to import it out of a component.
function planFor(source, forced = null) {
  const plan = [];
  let open = null;
  source.split('\n').forEach((content, index) => {
    const line = index + 1;
    const inside = open;
    open = blockAfter(content, open);
    const mixed = HAS_RTL.test(content);
    const side = forced || (inside ? 'ltr' : mixed ? lineDirection(content) : 'ltr');
    if (side === 'rtl') plan.push({ line, kind: 'dir' });
    if (!mixed && side !== 'rtl') return;
    const segments = inside ? [{ start: 0, end: content.length, code: true }] : segmentLine(content);
    for (const segment of segments) {
      if (segment.code) plan.push({ line, kind: 'code', start: segment.start, end: segment.end });
    }
  });
  return plan;
}

// The same lines as plain text, with a real isolate written round every stretch
// the plan fences off, for a browser to lay out with nothing of ours involved.
// It is the second opinion on every case at once: if the editor and this
// disagree, the decorations and the stylesheet between them are not saying what
// the characters would have said.
function oracleFor(source, plan) {
  return source.split('\n').map((content, index) => {
    const line = index + 1;
    const cuts = plan.filter(entry => entry.line === line && entry.kind === 'code');
    let text = '';
    let at = 0;
    for (const cut of cuts) {
      text += content.slice(at, cut.start) + '⁦' + content.slice(cut.start, cut.end) + '⁩';
      at = cut.end;
    }
    return {
      text: text + content.slice(at),
      dir: plan.some(entry => entry.line === line && entry.kind === 'dir') ? 'rtl' : 'ltr',
    };
  });
}

const monacoRoot = path.join(root, 'node_modules/monaco-editor');
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0}'
      + `#editor{width:900px;height:600px}</style><style>${bidiCss}</style><div id="editor"></div>`);
  }
  const file = path.join(monacoRoot, url);
  if (!file.startsWith(monacoRoot) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, resolve));

// `--no-sandbox` for the same reason the typing test passes it: this loads only
// local files, and Chromium's sandbox needs privileges that Ubuntu's AppArmor
// policy and most CI containers do not grant, so without it the test cannot run
// at all on Linux.
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
// Where every character of an element ended up, left to right. Asking each one
// for its own box is the only way to read a laid-out line back: the DOM keeps
// the text in logical order however the browser drew it.
await page.addScriptTag({ content: `window.charOrder = function (el) {
  const found = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let i = 0; i < node.data.length; i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const box = range.getBoundingClientRect();
      if (box.width || box.height) found.push({ ch: node.data[i], x: box.left, mid: box.left + box.width / 2 });
    }
  }
  return found.sort((a, b) => a.x - b.x);
};
window.readable = function (order) {
  // Monaco writes runs of spaces as no-break spaces; they are the same
  // character to the reader and to the bidi algorithm. The directional marks
  // take no room of their own — a placeholder box would not be stripped here,
  // which is how a regression to those gets caught.
  return order.map(o => o.ch).join('')
    .replace(/\\u00a0/g, ' ')
    .replace(/[\\u200e\\u200f\\u061c\\u202a-\\u202e\\u2066-\\u2069]/g, '');
};` });
await page.addScriptTag({ url: '/min/vs/loader.js' });
await page.evaluate(() => new Promise(done => {
  require.config({ paths: { vs: '/min/vs' } });
  require(['vs/editor/editor.main'], done);
}));

const results = await page.evaluate((cases) => {
  // One token per run of like characters. Real Typst highlighting is coarser
  // than this, so a rule that survives here survives the editor: the more spans
  // a line is cut into, the more chances the pieces have to reorder.
  monaco.languages.register({ id: 'probe' });
  monaco.languages.setMonarchTokensProvider('probe', {
    unicode: true,
    tokenizer: { root: [
      [/[\p{Letter}]+/u, 'identifier'], [/\d+/, 'number'],
      [/[$`@<>#[\]]/, 'keyword'], [/\S/, 'delimiter'],
    ] },
  });
  const editor = monaco.editor.create(document.getElementById('editor'), {
    value: '', language: 'probe', automaticLayout: false,
    minimap: { enabled: false }, wordWrap: 'off', scrollBeyondLastLine: false,
    renderControlCharacters: false,
  });

  const out = [];
  for (const item of cases) {
    const model = monaco.editor.createModel(item.source, 'probe');
    editor.setModel(model);
    editor.createDecorationsCollection(item.plan.map(entry => entry.kind === 'dir'
      ? { range: new monaco.Range(entry.line, 1, entry.line, model.getLineMaxColumn(entry.line)),
          options: { description: 'text-direction', textDirection: monaco.editor.TextDirection.RTL } }
      : { range: new monaco.Range(entry.line, entry.start + 1, entry.line, entry.end + 1),
          options: { description: 'bidi-isolate',
            beforeContentClassName: 'bidi-open', afterContentClassName: 'bidi-close' } }));
    editor.render(true);

    const host = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect();
    const lines = [];
    for (const el of document.querySelectorAll('.view-line')) {
      if (!el.textContent) continue;
      const order = charOrder(el);
      const box = el.getBoundingClientRect();
      lines.push({
        visual: readable(order),
        top: box.top,
        // Distance from each margin, to tell a line that starts at the right
        // edge from one that merely reads right to left.
        fromLeft: order.length ? order[0].x - host.left : 0,
        fromRight: order.length ? host.right - order[order.length - 1].x : 0,
      });
    }
    // Where the editor itself thinks each column of a fenced stretch sits. This
    // is the mapping the caret and the selection are drawn from, so it is the
    // one that says whether arrowing through a formula still walks across it in
    // a straight line. Without the isolates these come back jumbled, in the
    // same order the characters were drawn in.
    const columns = item.plan.filter(entry => entry.kind === 'code').map(entry => ({
      line: entry.line,
      start: entry.start,
      // The characters of the stretch, not the boundary past the end of it: in
      // a right-to-left line the caret after a fenced stretch belongs at its
      // far edge, where the sentence carries on, so that one column is a step
      // backwards by design.
      lefts: Array.from({ length: entry.end - entry.start }, (unused, offset) =>
        editor.getScrolledVisiblePosition({ lineNumber: entry.line, column: entry.start + 1 + offset }).left),
    }));

    // Monaco keeps rendered lines in whatever DOM order it likes.
    lines.sort((a, b) => a.top - b.top);
    out.push({ lines: lines.map(({ visual, fromLeft, fromRight }) => ({ visual, fromLeft, fromRight })), columns });
    model.dispose();
  }
  return out;
}, cases.map(item => ({ ...item, plan: planFor(item.source, item.forced || null) })));

const oracles = await page.evaluate((sets) => sets.map(lines => lines.map(line => {
  const div = document.createElement('div');
  div.dir = line.dir;
  div.style.cssText = 'font: 14px monospace; width: 900px; white-space: pre;';
  div.textContent = line.text;
  document.body.appendChild(div);
  const visual = readable(charOrder(div));
  div.remove();
  return visual;
})), cases.map(item => oracleFor(item.source, planFor(item.source, item.forced || null))));

let failures = 0;
for (const [index, item] of cases.entries()) {
  const { lines: got, columns } = results[index];
  try {
    // SHOW=1 prints what actually came back, for writing a new case against.
    if (process.env.SHOW) console.log(item.name, JSON.stringify(got.map(l => l.visual)));
    assert.deepEqual(got.map(l => l.visual), item.visual);
    // The editor has to agree with plain text laid out by the browser alone.
    assert.deepEqual(got.map(l => l.visual), oracles[index], 'the editor and plain text disagree');
    if (item.aligned === 'right') {
      assert.ok(got[0].fromRight < got[0].fromLeft,
        `expected the line at the right margin, sat ${Math.round(got[0].fromLeft)}px from the left`);
    }
    if (item.aligned === 'left') {
      assert.ok(got[0].fromLeft < got[0].fromRight,
        `expected the line at the left margin, sat ${Math.round(got[0].fromRight)}px from the right`);
    }
    // The caret has to walk a fenced stretch from one end to the other without
    // jumping about in the middle of it. This is the mapping the caret and the
    // selection are drawn from, so it is what says whether arrowing through a
    // formula still crosses it in a straight line; without the isolates these
    // come back as jumbled as the drawing was.
    for (const { line, start, lefts } of columns) {
      const piece = item.source.split('\n')[line - 1].slice(start, start + lefts.length);
      if (HAS_RTL.test(piece)) continue;
      assert.ok(lefts.every((left, offset) => offset === 0 || left > lefts[offset - 1]),
        `the caret positions across ${JSON.stringify(piece)} run ${lefts.map(Math.round).join(', ')}`);
    }
    // Whatever else moves, a stretch of code has to stay in one piece.
    for (const entry of planFor(item.source, item.forced || null)) {
      if (entry.kind !== 'code') continue;
      const source = item.source.split('\n')[entry.line - 1];
      const piece = source.slice(entry.start, entry.end);
      if (!piece.trim() || HAS_RTL.test(piece)) continue;
      assert.ok(got.some(l => l.visual.includes(piece)),
        `${JSON.stringify(piece)} was pulled apart`);
    }
  } catch (error) {
    failures++;
    console.error(`FAIL ${item.name}`);
    console.error(`  source ${JSON.stringify(item.source)}`);
    console.error(`  got    ${JSON.stringify(got.map(l => l.visual))}`);
    console.error(`  ${error.message.split('\n')[0]}`);
  }
}

await browser.close();
server.close();

if (failures) {
  console.error(`bidi layout: ${failures} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`bidi layout: ok (${cases.length} cases)`);
