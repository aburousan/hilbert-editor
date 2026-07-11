# Release notes

Paste the current section into the GitHub release when you cut a tag.

---

## 0.1.5

### Python and Julia notebooks

Write code straight into the document and press Run Notebook. Every code block in the
file runs as one session, so variables carry from cell to cell. Output is written back
underneath each block, plots come back as figures, and the compiled PDF marks each
block with its language logo.

![Python and Julia notebook cells](notebook-python-julia.png)

Saving no longer runs your code. A save typesets the document; only Run Notebook
executes anything.

### Finding things

⌘K opens a command palette covering every menu action, searchable by name.

Help → Features & Help opens a searchable list of what the app can do, where each
thing lives, and its shortcut.

### Export

The export dialog now offers PDF with page ranges, PDF/A archival standards, tagging
and pretty-printing, plus PNG, SVG, HTML, plain `.typ`, or the whole project folder.
It opens your system's save dialog instead of quietly writing to Downloads, remembers
your last format and folder, and can open the file when it is done.

### Editing

Feynman loops take fermion-flow arrows, clockwise or counter-clockwise.

The draw-a-symbol pad now recognises about 45 hand-drawn shapes and is no longer
marked experimental. Enter inserts the top match, 1 to 9 pick another, and Backspace
removes the last stroke.

Spelling and grammar checking (a basic checker: it catches misspellings and common
grammar slips, not subtle style problems). It is off by default; switch it on with the
tick icon in the header.

Data import reads CSV, TSV, and Excel, and will plot the columns you choose.

There is a two-column journal template, and ⌘⇧H inserts a full-width rule.

### Fixes

A failed compile no longer takes over the screen. The last good PDF stays up and the
errors move to their own tab.

The first load no longer shows a compile error before the backend has started.

Idle memory dropped from 173 MB to 12 MB. The spelling and grammar dictionaries cost
around 150 MB and were being preloaded at launch even though the checker is off by
default; they now load the first time you turn it on.

Exporting an SVG now shows the file in Finder rather than opening it, because the app
registered for `.svg` is often a source editor and would show you a wall of XML.

A GitHub personal access token is no longer written into `.git/config` when you push,
and it is stripped from any repository URL the app displays. A push that needs
credentials now fails quickly instead of hanging.

Requires Typst 0.15 or newer.
