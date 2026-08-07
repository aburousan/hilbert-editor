# Release notes

Paste the current section into the GitHub release when you cut a tag.

---

## 0.1.19

The Windows fixes, confirmed on the machine that had the problem. Also five
interface themes, settings that survive a restart, and a whiteboard that stops
arguing with itself about who saved it.

### Editing on Windows no longer gets stuck on "Compiling…"

The compiles were never slow. A user's log showed every one of them finishing in
about 110 ms while the preview sat there — what was failing was the save, and
every compile starts with one.

After writing a file the app read it straight back and remembered the hash of
what it read. That looks like the careful thing to do and is exactly the bug: on
Windows the write lands through a rename, and with a filter driver in the way —
every antivirus is one — the read that follows can still return the previous
contents. The editor then held a hash describing text one keystroke old, its next
save failed its own precondition, and the app announced that the file had
"changed outside Hilbert" about a change it had made itself. From there nothing
could be saved and nothing reached the preview.

It now records what it wrote. The follow-up log from the same user: 83 compiles,
median 120 ms, no stalls, no fallbacks.

### Projects on drives other than C: opened the wrong folder

An absolute path was resolved from a bare `/`, which on Windows throws the drive
away — opening `C:\Users\you\Documents\Hilbert` recorded the workspace as
`\Users\you\Documents\Hilbert`. Windows reads a leading slash as "the current
drive", so this was right by luck for anyone working on C: and quietly wrong for
anyone on D: or a mapped network drive.

### Tinymist installed by winget is found

A running program keeps the environment it was launched with, and the desktop
hands every app the copy it captured at login — so a tinymist installed since
then is on your `PATH` and invisible to the app at the same time. Hilbert now
looks where winget, scoop and chocolatey actually put their shims, and inside
winget's package folder directly.

### Whiteboards save once, and the preview updates

Ctrl+S on a whiteboard wrote the file twice: the drawing, and the editor's own
copy of it, which is only ever the last saved version. Whichever landed second
decided what was on disk, so the next save could fail its precondition — the
"changed outside Hilbert" dialog again — and it could put an older version of the
drawing back. Saving a whiteboard now also rebuilds the document, so the drawing
appears in the PDF straight away.

### Five interface themes

**Ink** (the default), **Paper**, **Sepia** for long low-blue sessions,
**Midnight** for a dark room or an OLED panel, and **High Contrast**. The
sun/moon button in the header cycles them and Settings lists them all. They dress
the whole window now, not just the editor pane; the PDF preview keeps its own
light/dark toggle.

### Settings stay set

Interface theme, editor font size, auto-compile delay, which panels are showing,
the pane sizes, and the interpreter picked for each language. These lived in the
webview's storage, which is keyed to the port the app happens to get — so a
second window or a stale process was enough to reset all of them. They live in a
file next to the session now.

### The app keeps a log

**Help → Copy Diagnostics** puts it on your clipboard along with which Typst and
Tinymist were found and the `PATH` they were found on. On Windows especially a
windowed app has no console to print to, which is why every report there had been
guesswork. It is what found the save bug above.

### Smaller things

- The preview keeps its place when the window or the panes are resized; on a long
  document you stay on the paragraph you were reading.
- A compile that runs long says so instead of showing the same word for longer,
  and gives up rather than spinning forever.
- Disposing an editor no longer surfaces Monaco's cancellation as an error.
- `lodash-es` moved to 4.18.1, clearing GHSA-r5fr-rjxr-66jc.

---

## 0.1.14

More collaboration fixes, and images display again. **If you use collaboration,
please update** — two of these could lose work without showing any sign of it.

### Collaboration no longer stops after you open an image

Opening an image or a PDF closes the text editor and builds a new one when you
come back. The shared session stayed attached to the old one, so from that moment
everything you typed stayed on your own machine. Nothing warned you: the
participant count stayed up, the status still said connected, and your
collaborator simply stopped seeing your work. The session now reattaches to the
editor you are actually typing in.

### Your text is no longer replaced by a second copy of the document

While two people were writing, a file could end up holding the document twice, or
lose a stretch of what one of you had written. When Hilbert reloaded a file from
disk it replaced the whole editor buffer, and during a shared session that
replacement was sent to everyone as a rewrite of the entire file. The file you
have open in a session is now left to the session, which is the only copy that
has everyone's edits in it.

### "File changed outside Hilbert" no longer interrupts a shared session

The prompt appeared at random while two people were typing, offering a choice
between your version and the one on disk. Nothing outside Hilbert had touched the
file: it was Hilbert's own save, and the app had lost track of what it had
written. Saves are now tracked as they happen, and inside a session the merged
document is kept without asking — the prompt was only ever offering to discard
your collaborator's work.

### Images, PDFs and plots display again

Opening an image showed a broken-image icon, and cropping and rotating could not
read the picture. Assets are now loaded the way the rest of the app loads files.
This also covers PDFs opened from the file tree and plots produced by a code run.

### The file tree no longer crawls through folders that are not yours

If another project sat inside the folder you opened, Hilbert read all of it —
every subdirectory, however large. With a big checkout next door the whole app
turned sluggish, down to dragging the divider between panes, and closing the file
tree was the only way to get the speed back. Hilbert now stops at anything that
is a separate project (anything with its own Git, Mercurial or Subversion
folder), at bulk directories such as `__pycache__` and `venv`, and once the tree
is already large. Those folders still appear, and opening one reads it then —
so nothing is hidden from you, it is just no longer read before you ask. The
walk also runs off the request thread now, so a slow folder cannot hold up the
rest of the app. Thanks to @johnblommers for the report and the diagnosis.

### Faster and steadier project transfer

An asset that failed to arrive is retried when someone who has it joins, several
assets transfer at once, and rejoining a folder you already have no longer
re-downloads pictures that have not changed.

---

## 0.1.12

Fixes for live collaboration, including three that could damage files, plus much
faster project transfer. **If you use collaboration, please update.**

### Rejoining a project no longer duplicates your text

Leaving a shared project and rejoining it could end with both people's version of
a file written into that file, one after the other — you would open it and find
the whole document twice. Rejoining keeps your tabs open, so the editor attached
to a file before the session had finished sending it, and both sides then wrote
their copy into the same empty slot. Rejoining is now safe: one version survives
and both people end up looking at the same thing.

### A deleted file no longer wipes the copy you had open

If someone deleted a file while you were away and you rejoined with that file
still open, your editor was blanked and the empty buffer saved over your copy —
even if you then chose to keep it. Your open document now survives, and the file
is shared back as yours. Files you do not have open are unaffected: you are still
shown the list and asked before anything is removed.

### Deleting a folder no longer leaves files behind

Deleting a folder missed any file that had arrived seconds earlier — one a
collaborator had just sent, or one a code run had just produced. Those files
stayed in the session and came back the next time anyone joined, with no way to
delete them again. Deletes, renames and copies now cover everything the session
actually holds.

### Images that failed to arrive can now recover

If the only person holding an image dropped out mid-transfer, that image stayed
missing for the rest of the session and only a rejoin brought it back. Hilbert
now retries automatically when someone joins who can supply it.

### Faster joining

Assets used to transfer strictly one at a time; several now transfer at once, and
text arrives first so the document compiles while images are still coming in.
Rejoining a folder you already have no longer re-downloads images that have not
changed — it checks what is already on your disk first. Joining an asset-heavy
project is several times quicker.

### Slide Studio

The experimental badge is gone from the Slide Studio window.

---

## 0.1.11

Live collaboration on a whole project, plus fixes in Slide Studio and the cetz
canvas.

### Live collaboration (experimental)

Share a whole project — text, images, fonts, whiteboards, and plots your code
generates — with someone else in real time, with no account and no server that
anyone runs for you. Everything is encrypted before it leaves your machine; the
relay only ever sees ciphertext, and each person keeps a real copy on their own
disk and compiles it locally, so the preview you see is your own Typst build of
the real document.

Joining asks where to put the project and creates the folder for you. Leave and
rejoin later and you can pick that same folder again: files the session also has
are brought up to date, files only you have are shared back, and anything deleted
while you were away is **listed and you are asked** before a single file on your
disk is touched.

It is **experimental**: expect the occasional reconnect or a file that lands a few
seconds late, and keep your own backup of anything important.

**Read [docs/COLLABORATION.md](https://github.com/aburousan/hilbert-editor/blob/main/docs/COLLABORATION.md)
before your first session** — it covers hosting, joining, rejoining an earlier
project folder, the three network setups (one router, campus, dedicated relay), and
troubleshooting.

### Slide Studio

Forward and Backward now work on arrows and curves. They were all drawn into one
overlay painted above everything else, so a curve always sat on top of every box
and label no matter how often you pressed the buttons.

Text and maths elements take their own font, suggested from the font files in your
project plus the ones Typst ships with. It applies per element, so one slide can mix
families; leaving it blank keeps the deck default.

Generated decks are also tidier to read: the numbering rules are set once at the top
instead of inside every element, only the pinit helpers actually used are imported,
and coordinates round to a tenth of a point.

### cetz canvas

Bézier curves have draggable control handles — add a Curve, press **Bend**, and pull
the two round handles to shape it. The handles are stored relative to the curve, so a
bent curve keeps its shape when you move or resize it. Inserting a plot from the code
runner no longer leaves a duplicate copy of the image in the project.

---

## 0.1.10

A feature release, plus fixes for things people hit while editing.

### Two projects at once

**File → New Window** opens a second window on another project. It's one running
app — a single icon in the Dock or taskbar — with fully independent windows: each
has its own preview, its own file tree, its own undo history, and remembers its own
project, so a second window never disturbs what the first one reopens next time.
Point a new window at the other project with **File → Open Folder**.

### Code intelligence

With tinymist installed, the Edit menu and the editor's right-click menu now do
go to definition, find references, rename a symbol across the file, quick fixes,
and whole-document formatting (F2) with the bundled typstyle formatter — on top of
the hover docs, completions and live diagnostics that were already there. Each open
window gets its own language server, so two projects don't interfere.

### The preview stays up, and the caret stays put

The last good render is shown from the moment you open a project — even if the very
first build has an error — so the page is never blank with just a wall of errors.
Errors live in a slim strip along the bottom (and the Problems panel); click
**Details / View errors** for the full list, **Back to preview** to return. Typing
while an error is on screen no longer makes the panel or the bottom bar jump around.

Separately, the cursor no longer jumps to another place in the file. When Hilbert
replaced a document's text behind the editor — reloading a file changed on disk, or
writing notebook output back — the caret could snap elsewhere; it now holds its
position through those replacements.

### Files changed outside Hilbert

If Git or another editor changes a file you have open, Hilbert reloads it
automatically. If you had unsaved edits, it shows your version and the version on
disk side by side and lets you choose, instead of silently overwriting either one.
Saving uses the same check, so two windows on the same file can't clobber each other.

### Notebook, export, and smaller things

- Running a notebook no longer discards text you typed while it was running — output
  is spliced into the live document, and it stops safely if the cells changed mid-run.
- The export dialog gained accessible PDF/A archive standards (PDF/A-2a, -3a, -2u, -4)
  and an accessibility preflight that checks the document title, language, and tagging
  before you export.
- An experimental **HTML Preview** (View menu) renders the document through Typst's
  HTML export.
- Right-clicking a file near a window edge no longer pushes its menu off screen — it
  repositions to stay fully visible.

Existing installs from 0.1.3 onwards pick this release up through the auto-updater.

---

## 0.1.9

A hotfix for 0.1.8.

### Ctrl+/ actually comments now

It did nothing at all in 0.1.8, on every platform. Two handlers were listening
for the shortcut: the one added in 0.1.8 and Monaco's own, on an element
containing it. Both ran, so the second toggle undid the first and the line came
back exactly as it was. Only one of them handles it now.

Two more things were wrong with it. The comment syntax was taken from the
editor's language configuration, which only exists for `.typ` here, so the
shortcut was a no-op in a `.py`, `.jl`, `.bib` or `.toml` file; the syntax now
follows the file you are in — `//`, `#`, `%` or `--`. And commenting a block
starts from the shallowest line in it, so an indented block keeps its shape.

### Comment / Uncomment Lines is in the Edit menu and the command palette

It was reachable only by its shortcut before, which is no help when the
shortcut is the thing that isn't working, or when your keyboard puts `/`
somewhere unusual. macOS shows ⌘/ and everywhere else Ctrl+/.

### Panel switches sit beside the panel they hide

The five switches in the status bar were all bunched in the bottom-right
corner, so hiding the file tree meant reaching for the opposite corner from the
tree. The sidebar and editor switches are on the left now and the PDF preview's
switch stays on the right. The View menu still lists all five together.

### The caret keeps its place when a document is reloaded

The editor's text is a controlled value, so whenever the app replaced a
document's contents behind the editor's back the whole file was rewritten in
one edit and the caret was left at the very end. It stays where it was. A file
with nothing remembered about it also opens at the top rather than the bottom —
only the starter template still opens at the end, which is the one place you
want to type after the text rather than into it.

Existing installs from 0.1.3 onwards pick this release up through the
auto-updater.

---

## 0.1.8

Mostly things people reported after 0.1.7.

### The cursor no longer jumps while you are typing

Starting to type could throw the cursor somewhere else in the file, so the
next few characters landed in the wrong place. Hilbert restores the cursor
position from your last session on startup, but it was waiting for the wrong
signal: the editor loads lazily, so the restore arrived too late and then fired
on the next change to the document — which is your first keystroke. It is
applied when the editor opens now, and typing cancels it outright. Coming back
to a tab also returns you to where you left off rather than to the top.

### Choose any Python or Julia, including one Hilbert didn't find

Settings → Interpreters now finds uv and pyenv environments, and the `.venv`
inside the project you have open — which is usually the one you actually want,
since it is the environment the code runs in. Anything else you can point at
yourself: browse to it or paste the path. Hilbert checks the file really is an
interpreter for that language before accepting it, labels it after the project
it belongs to, and remembers it.

Windows in particular got worse than it should have been: only `<env>\python.exe`
was checked, which is where conda puts it, while venv, virtualenv and uv put it
in `Scripts\`. That is why conda environments appeared there and project
`.venv`s did not. Both layouts are checked now. Windows also registers 0-byte
"app execution alias" stubs for python that open the Microsoft Store instead of
running anything; a real installation is preferred over one of those.

### Comment lines with Ctrl+/

⌘/ on macOS. This already existed through Monaco, but its shortcut is bound to
the physical US slash key, so it silently did nothing on AZERTY, QWERTZ and
other layouts where `/` needs a modifier. It now matches the character your
layout actually produces.

### Zoom the preview with the scroll wheel

Hold Ctrl (⌘ on macOS) and scroll over the page, or pinch on a trackpad, and
the preview zooms around the pointer. Alongside that, a bug that could leave
the page sitting off-centre next to a band of empty grey — with Fit unable to
put it back — is fixed. Each zoom level rebuilds the invisible text layer over
every page, and a slow rebuild for an old zoom level could finish last and
stretch the scrollable area. That also means double-clicking a word to jump to
its source is accurate again right after zooming.

### Hide the parts you are not using

A new View menu, and a status bar along the bottom, switch the file tree, file
outline, problems, editor and PDF preview on and off individually. Hide the
editor to read, hide the preview to write. The problem count in the corner
toggles the Problems panel the way an IDE does. Your layout is remembered, and
the editor and the preview cannot both be hidden.

Existing installs from 0.1.3 onwards pick this release up through the
auto-updater.

---

## 0.1.7

A feature release. The project also moved to a single repository — the frontend
and the Rust backend now live together, so building from source is one clone and
one `npm run dev` (see "Run from source" in the README).

### Slide Studio

A visual builder for 16:9 presentation slides. Drag, resize, and double-click-edit
text, equations, images, shapes, arrows, a translucent highlighter, and freehand
curves placed point by point (curves can now carry arrowheads at either end).
It comes with slide templates, undo/redo, copy/paste/duplicate, alignment helpers,
optional grid snapping, and a thumbnail rail you can reorder by dragging. The deck
is stored as ordinary Typst inside your document, so reopening the studio picks it
up for further editing — and while it's open, the equation galleries, Matrix
Studio, Feynman builder, plot tools and the rest drop their output onto the
current slide instead of into the text.

### Zotero citations

If the Zotero desktop app with the Better BibTeX plugin is running, Hilbert talks
to it locally: "Pick & cite" opens Zotero's own picker, and the chosen papers land
in `refs.bib` and are cited at the cursor in one go; "Import entire library"
merges your whole library without duplicates. Citation keys are sanitised to
Typst's legal character set (Better BibTeX can emit `$` inside a key when a title
contains maths, which breaks `@key` references), and keys already broken in
`refs.bib` heal themselves on the next import. If Zotero's main window is closed
— the app keeps running without one — Hilbert now reopens it automatically
instead of failing with a cryptic error.

### The preview recompiles several times faster while you type

The backend keeps one `typst watch` process per project, so a warm recompile
reuses the compiler's incremental state instead of paying process startup and a
full parse every time: roughly 120 ms instead of 500+ ms even for small
documents, and the default auto-compile delay dropped from 1 s to 0.1 s.
Switching projects, changing the main file, or importing fonts swaps the watcher
cleanly, a one-shot compile remains as the fallback, and quitting the app now
reliably shuts down the watcher and the language server instead of leaving them
running.

### Live errors from tinymist, before you compile

With tinymist installed, errors, warnings, and hints appear as squiggles in the
editor and in the Problems panel as you type. App Settings → General shows which
tinymist binary Hilbert found (bundled, environment, managed folder, or PATH),
its version, whether it's running, and a restart button.

### The local API now requires a per-launch token

The backend always listened on 127.0.0.1 only, with Host and Origin checks. On
top of that, every request now needs a random bearer token minted at launch and
handed only to the app's own window, so other local processes can't drive the
API. Scripted/headless use passes a `HILBERT_API_TOKEN` environment variable.

### Smaller things

- Wrapping a selection that cuts an emoji or a combining accent in half no
  longer produces invalid Typst — selections snap to character boundaries
  (the proofreader uses the same logic for its underlines).
- Edit Settings now edits your existing `#set text(...)` rule in place instead
  of stacking a new one on top, and accepts any font name and size.
- Problems panel entries say where they came from (Typst compiler vs tinymist).
- Code execution and compile endpoints are rate-bounded, and optional UI loads
  on first use, trimming startup work.

Existing installs from 0.1.3 onwards pick this release up through the
auto-updater.

---

## 0.1.6

A hotfix for three things people ran into with 0.1.5.

### Undo no longer resurrects the starter template

Reopening the app and pressing Ctrl+Z could replace your document with the
default starter text. The editor was quietly stacking your restored file on
top of the template it seeds new documents with. Fixed — undo now stops at
your own edits. Switching between projects also can't leak one document's
undo history into another anymore.

### The preview stopped flickering

Typing used to blank the preview to white on every recompile before the pages
came back. Pages now refresh in place: the old render stays on screen until
the new one is ready, so nothing flashes. The compile-error bar moved to the
bottom of the preview as well, so it no longer shoves the PDF down when an
error appears mid-edit.

### Export dialog, second pass

PDF version and conformance standard (PDF/A, PDF/UA) are now separate
choices instead of one mixed list. Exporting a project produces a single
`.zip` through the save dialog rather than copying loose files into a folder
— and the writer is built in, so it works the same on Windows. The redundant
"save straight to a folder" path is gone, the fields match the rest of the
UI, and the layout no longer jumps around when you switch formats.

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
