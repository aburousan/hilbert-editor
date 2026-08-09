export const TOOLBAR_GROUPS = [
  {
    id: 'navigation',
    label: 'Navigation & history',
    tools: [
      { id: 'sidebar', label: 'Toggle sidebar' },
      { id: 'undo', label: 'Undo', shortcut: 'Ctrl/⌘ Z' },
      { id: 'redo', label: 'Redo', shortcut: 'Ctrl/⌘ Shift Z' },
    ],
  },
  {
    id: 'text',
    label: 'Text formatting',
    tools: [
      { id: 'bold', label: 'Bold', shortcut: 'Ctrl/⌘ B' },
      { id: 'italic', label: 'Italic', shortcut: 'Ctrl/⌘ I' },
      { id: 'underline', label: 'Underline' },
      { id: 'font-size', label: 'Text size' },
      { id: 'text-color', label: 'Text colour' },
      { id: 'highlight', label: 'Highlight' },
    ],
  },
  {
    id: 'math',
    label: 'Math & symbols',
    tools: [
      { id: 'inline-math', label: 'Inline math', shortcut: 'Ctrl/⌘ E' },
      { id: 'display-equation', label: 'Display equation' },
      { id: 'equation-numbering', label: 'Toggle all equation numbers' },
      { id: 'single-equation-number', label: 'Toggle this equation number' },
      { id: 'center', label: 'Center selection' },
      { id: 'matrix', label: 'Matrix editor', shortcut: 'Ctrl/⌘ Shift M' },
      { id: 'symbols', label: 'Greek & physics symbols', shortcut: 'Ctrl/⌘ Shift P' },
      { id: 'draw-symbol', label: 'Draw symbol' },
    ],
  },
  {
    id: 'structure',
    label: 'Document structure',
    tools: [
      { id: 'heading', label: 'Heading / section' },
      { id: 'bullet-list', label: 'Bullet list' },
      { id: 'numbered-list', label: 'Numbered list' },
    ],
  },
  {
    id: 'objects',
    label: 'Figures & references',
    tools: [
      { id: 'figure', label: 'Figure' },
      { id: 'table', label: 'Table' },
      { id: 'label', label: 'Label / tag' },
      { id: 'cross-reference', label: 'Cross-reference' },
    ],
  },
  {
    id: 'code',
    label: 'Code',
    tools: [
      { id: 'code-block', label: 'Code block' },
      { id: 'run-notebook', label: 'Run notebook' },
    ],
  },
  {
    id: 'document',
    label: 'Document actions',
    tools: [
      { id: 'save', label: 'Save', shortcut: 'Ctrl/⌘ S' },
      { id: 'recompile', label: 'Recompile' },
    ],
  },
] as const;

export type ToolbarToolId = (typeof TOOLBAR_GROUPS)[number]['tools'][number]['id'];

export const TOOLBAR_TOOL_IDS = TOOLBAR_GROUPS.flatMap(group => group.tools.map(tool => tool.id)) as ToolbarToolId[];
const TOOLBAR_TOOL_ID_SET = new Set<string>(TOOLBAR_TOOL_IDS);

// Store the exceptions rather than every visible tool. A tool introduced by a
// future release is therefore visible by default instead of silently missing
// from an older preference file.
export function normalizeHiddenToolbarTools(value: unknown): ToolbarToolId[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<ToolbarToolId>();
  for (const item of value) {
    if (typeof item === 'string' && TOOLBAR_TOOL_ID_SET.has(item)) unique.add(item as ToolbarToolId);
  }
  return TOOLBAR_TOOL_IDS.filter(id => unique.has(id));
}

export const TOOLBAR_STORAGE_KEY = 'toolbar_hidden_tools_v1';

export function loadHiddenToolbarTools(): ToolbarToolId[] {
  try {
    return normalizeHiddenToolbarTools(JSON.parse(localStorage.getItem(TOOLBAR_STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}
