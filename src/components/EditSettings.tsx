import React, { useState } from 'react';

type TextRule = {
  start: number;
  end: number;
  body: string;
};

const KNOWN_FONTS = [
  'New Computer Modern',
  'Linux Libertine',
  'Arial',
  'Times New Roman',
];

function findTextRules(source: string): TextRule[] {
  const rules: TextRule[] = [];
  const pattern = /#set\s+text\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    const open = match.index + match[0].lastIndexOf('(');
    let depth = 1;
    let quote = '';
    let escaped = false;

    for (let i = open + 1; i < source.length; i++) {
      const char = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) {
        rules.push({ start: match.index, end: i + 1, body: source.slice(open + 1, i) });
        pattern.lastIndex = i + 1;
        break;
      }
    }
  }
  return rules;
}

function splitArguments(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = '';
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') round++;
    else if (char === ')') round--;
    else if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '{') curly++;
    else if (char === '}') curly--;
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function namedArgument(body: string, name: string): string | null {
  const part = splitArguments(body).find(arg => new RegExp(`^\\s*${name}\\s*:`).test(arg));
  return part ? part.replace(new RegExp(`^\\s*${name}\\s*:\\s*`), '').trim() : null;
}

function detectedTextSettings(source: string) {
  let fontValue: string | null = null;
  let sizeValue: string | null = null;
  for (const rule of findTextRules(source)) {
    fontValue = namedArgument(rule.body, 'font') || fontValue;
    sizeValue = namedArgument(rule.body, 'size') || sizeValue;
  }
  const fontMatch = fontValue?.match(/^"((?:\\.|[^"\\])*)"$/);
  const sizeMatch = sizeValue?.match(/^(\d+(?:\.\d+)?)pt$/);
  return {
    fontFamily: fontMatch ? fontMatch[1].replace(/\\([\\"])/g, '$1') : 'New Computer Modern',
    fontSize: sizeMatch ? sizeMatch[1] : '11',
  };
}

function setNamedArgument(body: string, name: string, value: string): string {
  const parts = splitArguments(body);
  const index = parts.findIndex(arg => new RegExp(`^\\s*${name}\\s*:`).test(arg));
  if (index >= 0) {
    const leading = parts[index].match(/^\s*/)?.[0] || '';
    const trailing = parts[index].match(/\s*$/)?.[0] || '';
    parts[index] = `${leading}${name}: ${value}${trailing}`;
    return parts.join(',');
  }

  const trailing = body.match(/\s*$/)?.[0] || '';
  const content = body.slice(0, body.length - trailing.length);
  return `${content}${content.trim() ? ', ' : ''}${name}: ${value}${trailing}`;
}

function escapeTypstString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export default function EditSettings({ onClose, editorRef, monaco }: { onClose: () => void, editorRef: React.MutableRefObject<any>, monaco: any }) {
  const initialText = detectedTextSettings(editorRef.current?.getValue?.() || '');
  const [fontSize, setFontSize] = useState(initialText.fontSize);
  const [fontFamily, setFontFamily] = useState(initialText.fontFamily);
  const [margin, setMargin] = useState('auto');
  const [pageColor, setPageColor] = useState('#ffffff');
  const [alignment, setAlignment] = useState('left');
  const [headingNumbering, setHeadingNumbering] = useState('none');

  const handleApply = () => {
    if (!editorRef.current || !monaco) return;
    const model = editorRef.current.getModel?.();
    if (!model) return;
    const family = fontFamily.trim() || 'New Computer Modern';
    const size = Math.min(144, Math.max(1, Number(fontSize) || 11));
    const source = model.getValue();
    const edits: { range: any, text: string, forceMoveMarkers: boolean }[] = [];
    const textRules = findTextRules(source);
    if (textRules.length) {
      const fontRule = [...textRules].reverse().find(rule => namedArgument(rule.body, 'font') !== null);
      const sizeRule = [...textRules].reverse().find(rule => namedArgument(rule.body, 'size') !== null);
      const fallbackRule = fontRule || sizeRule || textRules[0];
      const replacements = new Map<number, { rule: TextRule, body: string }>();
      const replaceArgument = (rule: TextRule, name: string, value: string) => {
        const current = replacements.get(rule.start) || { rule, body: rule.body };
        current.body = setNamedArgument(current.body, name, value);
        replacements.set(rule.start, current);
      };
      replaceArgument(fontRule || fallbackRule, 'font', `"${escapeTypstString(family)}"`);
      replaceArgument(sizeRule || fallbackRule, 'size', `${size}pt`);
      for (const { rule, body } of replacements.values()) {
        edits.push({
          range: monaco.Range.fromPositions(model.getPositionAt(rule.start), model.getPositionAt(rule.end)),
          text: `#set text(${body})`,
          forceMoveMarkers: true,
        });
      }
    } else {
      edits.push({
        range: new monaco.Range(1, 1, 1, 1),
        text: `#set text(font: "${escapeTypstString(family)}", size: ${size}pt)\n`,
        forceMoveMarkers: true,
      });
    }

    let code = '';
    if (margin !== 'auto') code += `#set page(margin: ${margin})\n`;
    if (pageColor !== '#ffffff') code += `#set page(fill: rgb("${pageColor}"))\n`;
    if (alignment !== 'left') code += `#set align(${alignment})\n`;
    if (headingNumbering !== 'none') code += `#set heading(numbering: "${headingNumbering}")\n`;
    if (code) edits.push({ range: new monaco.Range(1, 1, 1, 1), text: code, forceMoveMarkers: true });

    editorRef.current.executeEdits('settings', edits);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: 440, maxWidth: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Document Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label className="form-field">
              <span>Font family</span>
              <input list="document-font-families" value={fontFamily} onChange={e => setFontFamily(e.target.value)} />
              <datalist id="document-font-families">
                {KNOWN_FONTS.map(font => <option value={font} key={font} />)}
              </datalist>
            </label>
            <label className="form-field" style={{ maxWidth: 130 }}>
              <span>Font size</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="number" min="1" max="144" step="0.5" value={fontSize}
                  onChange={e => setFontSize(e.target.value)} style={{ minWidth: 0, width: '100%' }} />
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>pt</span>
              </div>
            </label>
          </div>

          <div className="form-row">
            <label className="form-field">
              <span>Margin</span>
              <select value={margin} onChange={e => setMargin(e.target.value)}>
                <option value="auto">Auto (default)</option>
                <option value="1in">1 inch</option>
                <option value="2cm">2 cm</option>
                <option value="2.5cm">2.5 cm</option>
              </select>
            </label>
            <label className="form-field">
              <span>Text alignment</span>
              <select value={alignment} onChange={e => setAlignment(e.target.value)}>
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
                <option value="justify">Justify</option>
              </select>
            </label>
          </div>

          <label className="form-field">
            <span>Heading numbering</span>
            <select value={headingNumbering} onChange={e => setHeadingNumbering(e.target.value)}>
              <option value="none">None</option>
              <option value="1.1.">1.1. — numbers</option>
              <option value="1.a.">1.a. — numbers &amp; letters</option>
              <option value="I.1.">I.1. — Roman numerals</option>
            </select>
          </label>

          <label className="form-field">
            <span>Page colour</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="color" value={pageColor} onChange={e => setPageColor(e.target.value)}
                style={{ width: 48, height: 34, padding: 2, cursor: 'pointer' }} />
              <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, color: 'var(--text-muted)' }}>{pageColor}</span>
            </div>
          </label>

          <div className="form-hint">Applied as <code>#set</code> rules at the top of the document. White page colour is left unset.</div>
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleApply}>Apply settings</button>
        </div>
      </div>
    </div>
  );
}
