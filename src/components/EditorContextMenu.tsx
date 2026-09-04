import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  copyEditorSelection,
  cutEditorSelection,
  pasteEditorClipboard,
  type ClipboardEditor,
} from '../editorClipboard';
import { keys } from '../keys';

// Monaco's own right-click menu is turned off in favour of this one, because
// its Cut/Copy/Paste entries cannot work inside a webview — see clipboard.ts.
// Everything else that menu offered is here too, run through the same action
// ids, so the only thing that changes is that the clipboard entries do what
// they say.

const mod = keys('⌘');
const alt = keys('⌥');
const shift = keys('⇧');

type Item =
  | { kind: 'divider' }
  | { kind: 'item'; label: string; keys?: string; disabled?: boolean; run: () => void | Promise<void> };

export default function EditorContextMenu({ at, editor, onClose }: {
  at: { x: number, y: number },
  editor: ClipboardEditor & {
    getAction(id: string): { run(): void | Promise<void> } | null;
    trigger(source: string, action: string, payload: unknown): void;
  },
  onClose: () => void,
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  // Keep the whole menu on screen — a right-click near the bottom of a tall
  // window would otherwise open most of it below the fold.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 6;
    setPos({
      x: Math.max(pad, Math.min(at.x, window.innerWidth - rect.width - pad)),
      y: Math.max(pad, Math.min(at.y, window.innerHeight - rect.height - pad)),
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('resize', onClose); };
  }, [onClose]);

  const trigger = (id: string) => () => { editor.focus(); editor.getAction(id)?.run(); };

  const items: Item[] = [
    { kind: 'item', label: 'Cut', keys: `${mod}X`, run: () => cutEditorSelection(editor) },
    { kind: 'item', label: 'Copy', keys: `${mod}C`, run: () => copyEditorSelection(editor) },
    { kind: 'item', label: 'Paste', keys: `${mod}V`, run: () => pasteEditorClipboard(editor) },
    { kind: 'item', label: 'Select All', keys: `${mod}A`, run: () => { editor.focus(); editor.trigger('menu', 'editor.action.selectAll', null); } },
    { kind: 'divider' },
    { kind: 'item', label: 'Go to Definition', keys: `${mod}F12`, run: trigger('editor.action.revealDefinition') },
    { kind: 'item', label: 'Go to References', keys: `${shift}F12`, run: trigger('editor.action.goToReferences') },
    { kind: 'item', label: 'Peek Definition', keys: `${alt}F12`, run: trigger('editor.action.peekDefinition') },
    { kind: 'item', label: 'Sync: reveal cursor position in the PDF', keys: `${mod}${alt}J`, run: trigger('hilbert.syncToPdf') },
    { kind: 'divider' },
    { kind: 'item', label: 'Rename Symbol', keys: 'F2', run: trigger('editor.action.rename') },
    { kind: 'item', label: 'Change All Occurrences', keys: `${mod}F2`, run: trigger('editor.action.changeAll') },
    { kind: 'item', label: 'Format Document', keys: `${mod}${shift}I`, run: trigger('editor.action.formatDocument') },
    { kind: 'divider' },
    { kind: 'item', label: 'Command Palette', keys: 'F1', run: trigger('editor.action.quickCommand') },
  ];

  return (
    <div
      ref={ref}
      className="context-menu dropdown"
      style={{ position: 'fixed', top: pos.y, left: pos.x, zIndex: 9999, display: 'block', minWidth: 260 }}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      {items.map((item, i) => item.kind === 'divider'
        ? <div key={i} className="dropdown-divider" />
        : (
          <div
            key={i}
            className="dropdown-item"
            style={item.disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
            onClick={async () => { onClose(); await item.run(); }}
          >
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.keys && <span style={{ color: 'var(--text-faint)', fontSize: '0.76rem' }}>{item.keys}</span>}
          </div>
        ))}
    </div>
  );
}
