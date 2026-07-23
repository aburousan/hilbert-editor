import { API } from './api';

let themesDefined = false;
let providersRegistered = false;

// Workspace image files, kept in sync by the app so that path completion inside
// image("…") can offer them (Overleaf-style). Updated via setWorkspaceImages.
let workspaceImagePaths: string[] = [];
export function setWorkspaceImages(paths: string[]) { workspaceImagePaths = paths.slice(); }

export function setupTypstLanguage(monacoInstance: any) {
  const languageId = 'typst';

  // Avoid re-registering on every mount.
  const already = monacoInstance.languages.getLanguages().some((l: any) => l.id === languageId);
  if (!already) monacoInstance.languages.register({ id: languageId });

  monacoInstance.languages.setLanguageConfiguration(languageId, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '$', close: '$' },
      { open: '*', close: '*' },
      { open: '_', close: '_' }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '$', close: '$' },
      { open: '*', close: '*' },
      { open: '_', close: '_' }
    ]
  });

  monacoInstance.languages.setMonarchTokensProvider(languageId, {
    defaultToken: '',
    tokenPostfix: '.typ',

    keywords: [
      'let', 'set', 'show', 'import', 'include', 'if', 'else', 'for',
      'while', 'return', 'as', 'in', 'not', 'and', 'or', 'none', 'auto', 'true', 'false'
    ],

    tokenizer: {
      root: [
        // comments
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],

        // headings (= , ==, ...)
        [/^\s*=+\s.*$/, 'heading'],

        // list / enum markers at line start
        [/^\s*[-+]\s/, 'markup.list'],

        // package imports: @preview/name:version
        [/@[a-zA-Z][\w-]*\/[\w-]+(:[\d.]+)?/, 'package'],

        // labels <name> and references @name
        [/<[a-zA-Z_][\w-]*>/, 'label'],

        // code mode keywords / functions starting with #
        [/#\s*([a-zA-Z_][\w-]*)/, {
          cases: { '$1@keywords': 'keyword', '@default': 'function' }
        }],

        // bare keywords inside code blocks
        [/\b([a-zA-Z_][\w-]*)\b(?=\s*[:(])/, {
          cases: { '$1@keywords': 'keyword', '@default': 'function.call' }
        }],

        // math mode
        [/\$/, { token: 'math.delim', next: '@math' }],

        // strong *...* and emph _..._
        [/\*[^*\n]+\*/, 'strong'],
        [/(^|\s)_[^_\n]+_/, 'emph'],

        // raw / code spans
        [/`[^`\n]+`/, 'raw'],

        // numbers + units
        [/\b\d+(\.\d+)?(pt|mm|cm|in|em|fr|deg|%)?\b/, 'number'],

        // strings
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/"/, { token: 'string.quote', next: '@string' }],

        [/[{}()\[\]]/, '@brackets']
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ],
      math: [
        [/\$/, { token: 'math.delim', next: '@pop' }],
        [/[a-zA-Z]+/, 'math.var'],
        [/[\^_/+\-*=()|<>]/, 'math.op'],
        [/[^$]/, 'math']
      ],
      string: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string.quote', next: '@pop' }]
      ]
    }
  });

  if (!themesDefined) {
    monacoInstance.editor.defineTheme('typst-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
        { token: 'heading', foreground: '60a5fa', fontStyle: 'bold' },
        { token: 'keyword', foreground: 'c084fc', fontStyle: 'bold' },
        { token: 'function', foreground: '38bdf8' },
        { token: 'function.call', foreground: '7dd3fc' },
        { token: 'package', foreground: 'f59e0b' },
        { token: 'label', foreground: 'fbbf24' },
        { token: 'string', foreground: '86efac' },
        { token: 'string.quote', foreground: '86efac' },
        { token: 'string.escape', foreground: 'fca5a5' },
        { token: 'number', foreground: 'fda4af' },
        { token: 'strong', foreground: 'f8fafc', fontStyle: 'bold' },
        { token: 'emph', foreground: 'cbd5e1', fontStyle: 'italic' },
        { token: 'raw', foreground: 'a5b4fc' },
        { token: 'markup.list', foreground: 'c084fc' },
        { token: 'math.delim', foreground: 'f472b6', fontStyle: 'bold' },
        { token: 'math.var', foreground: '5eead4' },
        { token: 'math.op', foreground: 'f472b6' },
        { token: 'math', foreground: '99f6e4' }
      ],
      colors: {
        'editor.background': '#0f172a',
        'editor.foreground': '#e2e8f0',
        'editorLineNumber.foreground': '#475569',
        'editorLineNumber.activeForeground': '#94a3b8',
        'editor.lineHighlightBackground': '#1e293b66',
        'editor.selectionBackground': '#8b5cf64d',
        'editorCursor.foreground': '#a78bfa',
        'editorIndentGuide.background1': '#1e293b',
        'editorBracketMatch.border': '#8b5cf6',
        'editorHoverWidget.background': '#1e293b',
        'editorHoverWidget.border': '#334155',
        'editorHoverWidget.foreground': '#e2e8f0',
        'editorHoverWidget.statusBarBackground': '#0f172a'
      }
    });

    monacoInstance.editor.defineTheme('typst-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '94a3b8', fontStyle: 'italic' },
        { token: 'heading', foreground: '2563eb', fontStyle: 'bold' },
        { token: 'keyword', foreground: '9333ea', fontStyle: 'bold' },
        { token: 'function', foreground: '0284c7' },
        { token: 'function.call', foreground: '0369a1' },
        { token: 'package', foreground: 'b45309' },
        { token: 'label', foreground: 'b45309' },
        { token: 'string', foreground: '15803d' },
        { token: 'string.quote', foreground: '15803d' },
        { token: 'number', foreground: 'be123c' },
        { token: 'strong', foreground: '0f172a', fontStyle: 'bold' },
        { token: 'emph', foreground: '334155', fontStyle: 'italic' },
        { token: 'raw', foreground: '4f46e5' },
        { token: 'markup.list', foreground: '9333ea' },
        { token: 'math.delim', foreground: 'db2777', fontStyle: 'bold' },
        { token: 'math.var', foreground: '0d9488' },
        { token: 'math.op', foreground: 'db2777' },
        { token: 'math', foreground: '0f766e' }
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#0f172a',
        'editorCursor.foreground': '#8b5cf6',
        'editor.selectionBackground': '#8b5cf633',
        'editorHoverWidget.background': '#f8fafc',
        'editorHoverWidget.border': '#cbd5e1',
        'editorHoverWidget.foreground': '#0f172a',
        'editorHoverWidget.statusBarBackground': '#f1f5f9'
      }
    });

    themesDefined = true;
  }

  if (providersRegistered) return;
  providersRegistered = true;

  const SNIPPET_RULE = monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet;

  // Inside a fenced ```lang … ``` code block (or an inline `raw` span)? There the
  // text is another language (Rust, Python, …), so Typst suggestions are noise.
  // Line-based fence scan — robust against the editor's backtick auto-closing.
  const inRawBlock = (model: any, position: any) => {
    if (/^\s*```/.test(model.getLineContent(position.lineNumber))) return true;   // on a fence line
    let inBlock = false;
    for (let ln = 1; ln < position.lineNumber; ln++)
      if (/^\s*```/.test(model.getLineContent(ln))) inBlock = !inBlock;
    if (inBlock) return true;
    const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    return ((lineBefore.match(/`/g) || []).length % 2) === 1;                     // open inline raw
  };
  // Are we typing the path string of an image("…") call? If so, only the image
  // path provider should answer (the others would be noise inside the string).
  const inImageArg = (model: any, position: any) =>
    /\bimage\(\s*"[^"]*$/.test(model.getLineContent(position.lineNumber).slice(0, position.column - 1));



  // Cross-reference autocomplete: when typing `@`, suggest labels (`<...>`)
  // that already exist in the document.
  monacoInstance.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['@'],
    provideCompletionItems: (model: any, position: any) => {
      if (inRawBlock(model, position)) return { suggestions: [] };
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const at = before.lastIndexOf('@');
      if (at === -1) return { suggestions: [] };
      // Bail out if there is whitespace between the @ and the cursor (not a ref).
      const typed = before.slice(at + 1);
      if (/\s/.test(typed)) return { suggestions: [] };

      const text = model.getValue();
      const labels = Array.from(text.matchAll(/<([a-zA-Z_][\w:.\-]*)>/g)).map((m: any) => m[1]);
      const uniq = Array.from(new Set(labels)) as string[];

      const range = {
        startLineNumber: position.lineNumber,
        startColumn: at + 2,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      };

      return {
        suggestions: uniq
          .filter(l => l.startsWith(typed))
          .map(l => ({
            label: '@' + l,
            kind: monacoInstance.languages.CompletionItemKind.Reference,
            insertText: l,
            range,
            detail: 'cross-reference',
            documentation: `Reference to <${l}>`
          }))
      };
    }
  });

  // Image-path autocomplete: while typing inside image("…"), suggest the image
  // files found in the workspace — like Overleaf's \includegraphics{…} picker.
  // The list is kept current by the app through setWorkspaceImages().
  monacoInstance.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['"', '/'],
    provideCompletionItems: (model: any, position: any) => {
      if (inRawBlock(model, position)) return { suggestions: [] };
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const m = before.match(/\bimage\(\s*"([^"]*)$/);
      if (!m) return { suggestions: [] };
      if (workspaceImagePaths.length === 0) return { suggestions: [] };
      const typed = m[1];
      // Replace whatever has been typed after the opening quote up to the cursor.
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column - typed.length,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };
      const File = monacoInstance.languages.CompletionItemKind.File;
      return {
        suggestions: workspaceImagePaths.map((p: string, i: number) => ({
          label: p,
          kind: File,
          insertText: p,
          filterText: p,
          range,
          detail: 'workspace image',
          documentation: p,
          // Preserve tree order in the list rather than alphabetising labels.
          sortText: String(i).padStart(5, '0'),
        })),
      };
    },
  });

  // ─── Tinymist hover provider ───────────────────────────────────────────────
  // Calls the backend /lsp/hover endpoint which proxies to a long-lived tinymist
  // LSP process. Returns rich markdown documentation for any Typst symbol.
  monacoInstance.languages.registerHoverProvider(languageId, {
    provideHover: async (model: any, position: any) => {
      try {
        // Determine the file path from the model URI (strip leading /)
        const modelPath = model.uri.path.replace(/^\//, '');
        const content = model.getValue();
        const res = await fetch(`${API}/lsp/hover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: modelPath,
            line: position.lineNumber - 1,  // LSP uses 0-based lines
            character: position.column - 1,  // LSP uses 0-based columns
            content,
          }),
        });
        const data = await res.json();
        if (!data.contents) return null;
        const range = data.range ? {
          startLineNumber: data.range.start.line + 1,
          startColumn: data.range.start.character + 1,
          endLineNumber: data.range.end.line + 1,
          endColumn: data.range.end.character + 1,
        } : undefined;
        return {
          range,
          contents: [{ value: data.contents, isTrusted: true, supportHtml: true }],
        };
      } catch {
        return null;
      }
    },
  });

  // ─── Tinymist completion provider ──────────────────────────────────────────
  monacoInstance.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['.', ':', '#', '@', '"', '/'],
    provideCompletionItems: async (model: any, position: any) => {
      try {
        // Inside image("…") the curated workspace-image provider owns the list
        // (filtered to real image files, tree order). Tinymist would otherwise
        // dump every file on disk here — PDFs, sandbox/, out.pdf — as raw paths.
        // In fenced/raw blocks the text is another language, so skip too.
        if (inImageArg(model, position) || inRawBlock(model, position)) return { suggestions: [] };
        const modelPath = model.uri.path.replace(/^\//, '');
        const content = model.getValue();
        const res = await fetch(`${API}/lsp/completion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file: modelPath,
            line: position.lineNumber - 1,
            character: position.column - 1,
            content,
          }),
        });
        const data = await res.json();
        if (!data.items || !Array.isArray(data.items)) return { suggestions: [] };
        
        const suggestions = data.items.map((item: any) => {
          let kind = monacoInstance.languages.CompletionItemKind.Property;
          if (item.kind === 3) kind = monacoInstance.languages.CompletionItemKind.Function;
          else if (item.kind === 6) kind = monacoInstance.languages.CompletionItemKind.Variable;
          else if (item.kind === 9) kind = monacoInstance.languages.CompletionItemKind.Module;
          else if (item.kind === 14) kind = monacoInstance.languages.CompletionItemKind.Keyword;
          
          let range: any = undefined;
          if (item.textEdit?.range) {
            range = {
              startLineNumber: item.textEdit.range.start.line + 1,
              startColumn: item.textEdit.range.start.character + 1,
              endLineNumber: item.textEdit.range.end.line + 1,
              endColumn: item.textEdit.range.end.character + 1,
            };
          }
          
          return {
            label: typeof item.label === 'string' ? item.label : item.label?.label || '',
            kind,
            detail: item.detail || '',
            documentation: typeof item.documentation === 'object' ? { value: item.documentation.value, isTrusted: true } : item.documentation,
            insertText: item.textEdit?.newText || item.insertText || (typeof item.label === 'string' ? item.label : item.label?.label || ''),
            insertTextRules: item.insertTextFormat === 2 ? monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range,
            sortText: item.sortText || item.label,
          };
        });
        
        return { suggestions };
      } catch {
        return { suggestions: [] };
      }
    }
  });

  const fromLspRange = (range: any) => ({
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  });

  const documentPayload = (model: any, position?: any) => ({
    file: model.uri.path.replace(/^\//, ''),
    content: model.getValue(),
    ...(position ? { line: position.lineNumber - 1, character: position.column - 1 } : {}),
  });

  const ensureWorkspaceModel = async (file: string) => {
    const uri = monacoInstance.Uri.file('/' + file.replace(/^\/+/, ''));
    const existing = monacoInstance.editor.getModel(uri);
    if (existing) return existing;
    const response = await fetch(`${API}/workspace/file/state?path=${encodeURIComponent(file)}`);
    if (!response.ok) return null;
    const state = await response.json();
    const model = monacoInstance.editor.createModel(state.content || '', languageId, uri);
    window.dispatchEvent(new CustomEvent('hilbert:lsp-model-opened', {
      detail: { file, content: state.content || '', diskHash: state.hash || undefined },
    }));
    return model;
  };

  const locations = async (items: any[]) => {
    const out = [];
    for (const item of items || []) {
      const model = await ensureWorkspaceModel(item.file);
      if (model && item.range) out.push({ uri: model.uri, range: fromLspRange(item.range) });
    }
    return out;
  };

  const workspaceEdits = async (changes: any[]) => {
    const edits = [];
    for (const change of changes || []) {
      const model = await ensureWorkspaceModel(change.file);
      if (!model) continue;
      for (const edit of change.edits || []) {
        if (!edit.range || typeof edit.newText !== 'string') continue;
        edits.push({
          resource: model.uri,
          textEdit: { range: fromLspRange(edit.range), text: edit.newText },
          versionId: model.getVersionId(),
        });
      }
    }
    return edits;
  };

  monacoInstance.languages.registerDefinitionProvider(languageId, {
    provideDefinition: async (model: any, position: any) => {
      try {
        const response = await fetch(`${API}/lsp/definition`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(documentPayload(model, position)),
        });
        return locations((await response.json()).locations);
      } catch {
        return [];
      }
    },
  });

  monacoInstance.languages.registerReferenceProvider(languageId, {
    provideReferences: async (model: any, position: any) => {
      try {
        const response = await fetch(`${API}/lsp/references`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(documentPayload(model, position)),
        });
        return locations((await response.json()).locations);
      } catch {
        return [];
      }
    },
  });

  monacoInstance.languages.registerRenameProvider(languageId, {
    provideRenameEdits: async (model: any, position: any, newName: string) => {
      try {
        const response = await fetch(`${API}/lsp/rename`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...documentPayload(model, position), newName }),
        });
        const data = await response.json();
        return { edits: await workspaceEdits(data.changes) };
      } catch {
        return { edits: [], rejectReason: 'Tinymist could not rename this symbol.' };
      }
    },
  });

  monacoInstance.languages.registerDocumentFormattingEditProvider(languageId, {
    provideDocumentFormattingEdits: async (model: any) => {
      try {
        const response = await fetch(`${API}/lsp/format`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(documentPayload(model)),
        });
        const data = await response.json();
        return (data.edits || []).map((edit: any) => ({
          range: fromLspRange(edit.range),
          text: edit.newText,
        }));
      } catch {
        return [];
      }
    },
  });

  monacoInstance.languages.registerCodeActionProvider(languageId, {
    provideCodeActions: async (model: any, range: any) => {
      try {
        const response = await fetch(`${API}/lsp/code-actions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...documentPayload(model, { lineNumber: range.startLineNumber, column: range.startColumn }),
            endLine: range.endLineNumber - 1,
            endCharacter: range.endColumn - 1,
          }),
        });
        const data = await response.json();
        const actions = [];
        for (const action of data.actions || []) {
          actions.push({
            title: action.title,
            kind: action.kind || 'quickfix',
            isPreferred: !!action.preferred,
            edit: { edits: await workspaceEdits(action.changes) },
          });
        }
        return { actions, dispose: () => {} };
      } catch {
        return { actions: [], dispose: () => {} };
      }
    },
  });

  // ─── Control-flow: content-block ([ ]) variants ────────────────────────────
  // Typst lets `if`/`else`/`for`/`while` take EITHER a code block `{ … }` (runs
  // statements; bare words are variables) OR a content block `[ … ]` (shows
  // markup — the form used throughout the Typst docs). Tinymist only offers the
  // `{ }` forms, so we add matching `[ ]` forms. Scoped to `#`-prefixed keywords
  // in markup (e.g. `#if`), which is where beginners hit the "unknown variable"
  // trap from writing text inside `{ }`.
  monacoInstance.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['#'],
    provideCompletionItems: (model: any, position: any) => {
      if (inRawBlock(model, position) || inImageArg(model, position)) return { suggestions: [] };
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      // Only when typing a `#`-prefixed keyword (`#if`, `#for`, `#while`, `#else`).
      const m = before.match(/#([a-zA-Z]*)$/);
      if (!m) return { suggestions: [] };
      const word = m[1];
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column - word.length,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };
      const Snippet = monacoInstance.languages.CompletionItemKind.Snippet;
      const snip = (label: string, detail: string, keyword: string, insertText: string) => ({
        label,
        kind: Snippet,
        detail,
        insertText,
        insertTextRules: SNIPPET_RULE,
        filterText: keyword,     // surface by the keyword, not the descriptive label
        range,
        sortText: '0_' + label,  // rank near the top of the keyword's matches
      });
      return {
        suggestions: [
          snip('if … [ ]  (content branch)', 'conditional — shows markup', 'if',
            'if ${1:condition} [\n\t${0}\n]'),
          snip('if … else … [ ]  (content branches)', 'conditional with else — shows markup', 'if',
            'if ${1:condition} [\n\t${2}\n] else [\n\t${0}\n]'),
          snip('for … [ ]  (content loop)', 'loop — shows markup', 'for',
            'for ${1:item} in ${2:(1, 2, 3)} [\n\t${0}\n]'),
          snip('while … [ ]  (content loop)', 'loop — shows markup', 'while',
            'while ${1:condition} [\n\t${0}\n]'),
        ],
      };
    },
  });
}
