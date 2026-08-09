import { useEffect } from 'react';
import {
  TOOLBAR_GROUPS,
  TOOLBAR_TOOL_IDS,
  type ToolbarToolId,
} from '../toolbarPreferences';

type Props = {
  hidden: ToolbarToolId[];
  onChange: (hidden: ToolbarToolId[]) => void;
  onClose: () => void;
};

export default function ToolbarPreferencesModal({ hidden, onChange, onClose }: Props) {
  const hiddenSet = new Set(hidden);
  const visibleCount = TOOLBAR_TOOL_IDS.length - hidden.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setVisible = (id: ToolbarToolId, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(id);
    else next.add(id);
    onChange(TOOLBAR_TOOL_IDS.filter(tool => next.has(tool)));
  };

  const setGroupVisible = (ids: readonly ToolbarToolId[], visible: boolean) => {
    const next = new Set(hidden);
    for (const id of ids) {
      if (visible) next.delete(id);
      else next.add(id);
    }
    onChange(TOOLBAR_TOOL_IDS.filter(tool => next.has(tool)));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <section
        className="modal-content toolbar-preferences"
        role="dialog"
        aria-modal="true"
        aria-labelledby="toolbar-preferences-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-header toolbar-preferences-header">
          <div>
            <h2 id="toolbar-preferences-title">Customize Toolbar</h2>
            <p>{visibleCount} of {TOOLBAR_TOOL_IDS.length} tools shown</p>
          </div>
          <button className="tab-close" type="button" aria-label="Close toolbar preferences" onClick={onClose}>×</button>
        </div>

        <div className="toolbar-preferences-actions">
          <button type="button" className="btn-ghost" onClick={() => onChange([])}>Show all</button>
          <button type="button" className="btn-ghost" onClick={() => onChange([...TOOLBAR_TOOL_IDS])}>Hide all</button>
        </div>

        <div className="toolbar-preferences-groups">
          {TOOLBAR_GROUPS.map(group => {
            const ids = group.tools.map(tool => tool.id) as ToolbarToolId[];
            const allVisible = ids.every(id => !hiddenSet.has(id));
            return (
              <fieldset className="toolbar-preference-group" key={group.id}>
                <legend>
                  <span>{group.label}</span>
                  <button type="button" onClick={() => setGroupVisible(ids, !allVisible)}>
                    {allVisible ? 'Hide group' : 'Show group'}
                  </button>
                </legend>
                <div className="toolbar-preference-grid">
                  {group.tools.map(tool => (
                    <label key={tool.id}>
                      <input
                        type="checkbox"
                        checked={!hiddenSet.has(tool.id)}
                        onChange={event => setVisible(tool.id, event.target.checked)}
                      />
                      <span>{tool.label}</span>
                      {'shortcut' in tool && tool.shortcut && <kbd>{tool.shortcut}</kbd>}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>

        <div className="toolbar-preferences-footer">
          <span>Keyboard shortcuts and menu commands keep working when their buttons are hidden.</span>
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
