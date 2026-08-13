import React, { useEffect, useState } from 'react';
import { API } from '../api';
import {
  DOCUMENT_LANGUAGES,
  detectedDirection,
  escapeTypstString,
  findTextRules,
  isRtlLanguage,
  namedArgument,
  setNamedArgument,
  unquoteTypstString,
  type DocumentDirection,
  type TextRule,
} from '../textDirection';

const KNOWN_FONTS = [
  'New Computer Modern',
  'Linux Libertine',
  'Arial',
  'Times New Roman',
];

// Typst's default families have no Arabic glyphs of their own, so a document
// that keeps them falls through to whatever the system offers — and on a plain
// Linux install that is a font with the letters but no joining rules, which
// prints every Arabic letter in its isolated form. Measured on Ubuntu 22.04:
// New Computer Modern comes out disconnected, DejaVu Sans and the Kacst
// families come out properly joined. Hebrew has no joining to get wrong, so it
// survives the same fallback; these are still better shapes for it.
//
// Ordered best first, and the last few are the ones that tend to be present
// when nothing else is.
const RTL_FONTS: Record<string, string[]> = {
  ar: ['Noto Naskh Arabic', 'Amiri', 'Scheherazade New', 'Geeza Pro', 'KacstOne', 'KacstNaskh', 'FreeSerif', 'DejaVu Sans'],
  fa: ['Noto Naskh Arabic', 'Vazirmatn', 'Amiri', 'Geeza Pro', 'KacstFarsi', 'FreeSerif', 'DejaVu Sans'],
  ur: ['Noto Nastaliq Urdu', 'Jameel Noori Nastaleeq', 'Noto Naskh Arabic', 'FreeSerif', 'DejaVu Sans'],
  ps: ['Noto Naskh Arabic', 'Geeza Pro', 'KacstOne', 'FreeSerif', 'DejaVu Sans'],
  sd: ['Noto Naskh Arabic', 'Geeza Pro', 'KacstOne', 'FreeSerif', 'DejaVu Sans'],
  ug: ['Noto Naskh Arabic', 'Geeza Pro', 'KacstOne', 'FreeSerif', 'DejaVu Sans'],
  he: ['Noto Sans Hebrew', 'David CLM', 'Arial Hebrew', 'FreeSerif', 'DejaVu Sans'],
  yi: ['Noto Sans Hebrew', 'Arial Hebrew', 'FreeSerif', 'DejaVu Sans'],
  dv: ['Noto Sans Thaana', 'MV Boli'],
};

function detectedTextSettings(source: string) {
  let fontValue: string | null = null;
  let sizeValue: string | null = null;
  for (const rule of findTextRules(source)) {
    fontValue = namedArgument(rule.body, 'font') || fontValue;
    sizeValue = namedArgument(rule.body, 'size') || sizeValue;
  }
  const sizeMatch = sizeValue?.match(/^(\d+(?:\.\d+)?)pt$/);
  return {
    fontFamily: unquoteTypstString(fontValue) ?? 'New Computer Modern',
    fontSize: sizeMatch ? sizeMatch[1] : '11',
  };
}

export default function EditSettings({ onClose, editorRef, monaco }: { onClose: () => void, editorRef: React.MutableRefObject<any>, monaco: any }) {
  const source = editorRef.current?.getValue?.() || '';
  const initialText = detectedTextSettings(source);
  const initialDirection = detectedDirection(source);
  const [fontSize, setFontSize] = useState(initialText.fontSize);
  const [fontFamily, setFontFamily] = useState(initialText.fontFamily);
  const [lang, setLang] = useState(initialDirection.lang);
  const [dir, setDir] = useState<DocumentDirection>(initialDirection.dir);
  const [margin, setMargin] = useState('auto');
  const [pageColor, setPageColor] = useState('#ffffff');
  const [alignment, setAlignment] = useState('left');
  const [headingNumbering, setHeadingNumbering] = useState('none');

  // What this machine can actually typeset with. Without it the advice below
  // is a guess, and a guess that names an uninstalled font leaves the reader
  // exactly where they started.
  const [installed, setInstalled] = useState<string[] | null>(null);
  useEffect(() => {
    let dropped = false;
    fetch(`${API}/fonts`)
      .then(r => r.json())
      .then(data => { if (!dropped && Array.isArray(data?.families)) setInstalled(data.families); })
      .catch(() => {});
    return () => { dropped = true; };
  }, []);

  // Whether this document will come out right-to-left once applied, which is
  // what decides if the font warning below is worth showing.
  const rtl = dir === 'rtl' || (dir === 'auto' && isRtlLanguage(lang));
  const scriptFonts = RTL_FONTS[lang.trim().toLowerCase().split(/[-_]/)[0]] || [];
  const fontLooksLatin = KNOWN_FONTS.includes(fontFamily.trim());
  const has = (name: string) => !installed || installed.includes(name);
  // The best candidate that is really here. Before the list arrives this is
  // simply the best candidate, which is the old behaviour.
  const suggestion = scriptFonts.find(has);

  const handleApply = () => {
    if (!editorRef.current || !monaco) return;
    const model = editorRef.current.getModel?.();
    if (!model) return;
    const family = fontFamily.trim() || 'New Computer Modern';
    const size = Math.min(144, Math.max(1, Number(fontSize) || 11));
    const code = model.getValue();
    const edits: { range: any, text: string, forceMoveMarkers: boolean }[] = [];
    const textRules = findTextRules(code);
    // Leaving dir out is not the same as writing `dir: auto`, but it is what
    // Typst does by default and it keeps the rule readable, so "Automatic"
    // takes the argument back out rather than pinning it.
    const dirValue = dir === 'auto' ? null : dir;
    const langValue = `"${escapeTypstString(lang.trim() || 'en')}"`;

    if (textRules.length) {
      const ruleWith = (name: string) => [...textRules].reverse().find(rule => namedArgument(rule.body, name) !== null);
      const fontRule = ruleWith('font');
      const sizeRule = ruleWith('size');
      const fallbackRule = fontRule || sizeRule || textRules[0];
      const replacements = new Map<number, { rule: TextRule, body: string }>();
      const replaceArgument = (rule: TextRule, name: string, value: string | null) => {
        const current = replacements.get(rule.start) || { rule, body: rule.body };
        current.body = setNamedArgument(current.body, name, value);
        replacements.set(rule.start, current);
      };
      replaceArgument(fontRule || fallbackRule, 'font', `"${escapeTypstString(family)}"`);
      replaceArgument(sizeRule || fallbackRule, 'size', `${size}pt`);
      replaceArgument(ruleWith('lang') || fallbackRule, 'lang', langValue);
      // A dir already in the file has to be revisited even when the answer is
      // "take it out", or switching back to Automatic would change nothing.
      const dirRule = ruleWith('dir');
      if (dirRule || dirValue) replaceArgument(dirRule || fallbackRule, 'dir', dirValue);
      for (const { rule, body } of replacements.values()) {
        edits.push({
          range: monaco.Range.fromPositions(model.getPositionAt(rule.start), model.getPositionAt(rule.end)),
          text: `#set text(${body})`,
          forceMoveMarkers: true,
        });
      }
    } else {
      const args = [`font: "${escapeTypstString(family)}"`, `size: ${size}pt`, `lang: ${langValue}`];
      if (dirValue) args.push(`dir: ${dirValue}`);
      edits.push({
        range: new monaco.Range(1, 1, 1, 1),
        text: `#set text(${args.join(', ')})\n`,
        forceMoveMarkers: true,
      });
    }

    let extra = '';
    if (margin !== 'auto') extra += `#set page(margin: ${margin})\n`;
    if (pageColor !== '#ffffff') extra += `#set page(fill: rgb("${pageColor}"))\n`;
    if (alignment !== 'left') extra += `#set align(${alignment})\n`;
    if (headingNumbering !== 'none') extra += `#set heading(numbering: "${headingNumbering}")\n`;
    if (extra) edits.push({ range: new monaco.Range(1, 1, 1, 1), text: extra, forceMoveMarkers: true });

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
                {[...new Set([...scriptFonts.filter(has), ...KNOWN_FONTS.filter(has), ...(installed || [])])]
                  .map(font => <option value={font} key={font} />)}
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
              <span>Language</span>
              <input list="document-languages" value={lang} onChange={e => setLang(e.target.value)} />
              <datalist id="document-languages">
                {DOCUMENT_LANGUAGES.map(l => <option value={l.code} key={l.code} label={l.label} />)}
              </datalist>
            </label>
            <label className="form-field">
              <span>Text direction</span>
              <select value={dir} onChange={e => setDir(e.target.value as DocumentDirection)}>
                <option value="auto">From the language</option>
                <option value="ltr">Left-to-right</option>
                <option value="rtl">Right-to-left</option>
              </select>
            </label>
          </div>

          {rtl && fontLooksLatin && scriptFonts.length > 0 && (
            <div className="form-hint" style={{ color: '#f59e0b' }}>
              <b>{fontFamily.trim()}</b> has no glyphs for this script, so the PDF falls back to whatever the system
              offers — which for Arabic script is usually a font that prints every letter on its own instead of
              joining them up.{' '}
              {suggestion
                ? <>Try <b>{suggestion}</b> instead.</>
                : <>None of the fonts this script needs is installed here; add one (<b>{scriptFonts[0]}</b> is a
                  good choice) or import a font under File → Import Font.</>}
            </div>
          )}
          {installed && fontFamily.trim() && !installed.includes(fontFamily.trim()) && !fontLooksLatin && (
            <div className="form-hint" style={{ color: '#f59e0b' }}>
              No font called <b>{fontFamily.trim()}</b> is installed on this machine, so Typst will quietly use
              something else.
            </div>
          )}

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
