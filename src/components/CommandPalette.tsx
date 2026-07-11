import { useEffect, useMemo, useRef, useState } from 'react';

export type PaletteCommand = {
  title: string;
  category: string;
  hint?: string;      // keyboard shortcut shown on the right
  run: () => void;
};

// Rank a command against the query: word-prefix beats substring beats
// subsequence, earlier matches beat later ones. 0 = no match.
function score(q: string, cmd: PaletteCommand): number {
  if (!q) return 1;
  const hay = `${cmd.title} ${cmd.category}`.toLowerCase();
  const idx = hay.indexOf(q);
  if (idx === 0 || (idx > 0 && hay[idx - 1] === ' ')) return 100 - idx;
  if (idx > 0) return 50 - Math.min(idx, 40);
  // subsequence: every query char appears in order
  let i = 0;
  for (const ch of hay) { if (ch === q[i]) i++; if (i === q.length) return 10; }
  return 0;
}

export default function CommandPalette({ commands, onClose }: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands
      .map(c => ({ c, s: score(q, c) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map(x => x.c);
  }, [query, commands]);

  useEffect(() => { setSel(0); }, [query]);

  // Keep the highlighted row in view while arrowing through the list.
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const pick = (cmd: PaletteCommand | undefined) => {
    if (!cmd) return;
    onClose();
    // Let the overlay unmount first so the command's own modal gets focus.
    setTimeout(() => { try { cmd.run(); } catch { /* a broken command shouldn't take the app down */ } }, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(matches[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {matches.map((cmd, i) => (
            <div
              key={`${cmd.category}:${cmd.title}`}
              className={`palette-item${i === sel ? ' selected' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(cmd)}
            >
              <span className="palette-cat">{cmd.category}</span>
              <span className="palette-title">{cmd.title}</span>
              {cmd.hint && <span className="palette-hint">{cmd.hint}</span>}
            </div>
          ))}
          {matches.length === 0 && <div className="palette-empty">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}
