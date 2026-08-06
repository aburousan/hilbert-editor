# The compile that never comes back (Windows)

Reported in [#23](https://github.com/aburousan/hilbert-editor/issues/23). The first edits render,
then the status bar says *Compiling…* and stays there. This page is what I found, what changed, and
what I need back to be sure.

If you are here because it is happening to you, you can skip to
[What to do](#what-to-do) — and step 4 is the one that matters.

---

## What the report pinned down

A screen recording made this specific. The heading renders fine. The moment a second line is
started, the preview stops and never recovers — but the file outline keeps updating, so the editor
itself is alive. Only the compile is stuck. The word count freezes because it is counted from the
rendered PDF, not from the source.

### A cycle that was announced and never finished

Hilbert drives the preview with `typst watch`, which prints `compiling ...` and then prints how it
went. Hilbert waited up to 30 seconds for that second line — and if it never arrived, it kept
believing the first one **forever**. Every keystroke after that paid the full 30 seconds.

That accounts for all three symptoms in the report: stuck on *Compiling…*, saving appearing to do
nothing, and a `typst.exe` sitting there idle.

### Why this never showed up on macOS or Linux

Because there, the two lines always pair up. Hammering the editor with rapid edits:

| Platform | Cycles announced | Cycles finished | Lost |
| --- | ---: | ---: | ---: |
| macOS | 33 | 33 | 0 |
| Linux | 29 | 29 | 0 |

Three things make Windows different:

1. Windows delivers file-change notifications immediately instead of coalescing them, so one save
   can start several watch cycles where Unix starts one. More cycles, more chances for one to go
   missing.
2. Renaming onto a file another process has open can fail on Windows with a sharing violation. On
   Unix that is a non-event — `rename` is atomic, and a reader holding the old inode simply reads
   the old file. There is no equivalent failure to have.
3. The announcement never expired, which is what made it permanent rather than a hiccup. One
   unlucky save wedged the session for good.

The 30-second wait itself was cross-platform. Only the trigger was Windows-only.

### A fallback with no time limit at all

When the watcher was written off, Hilbert compiled directly instead — with no ceiling on how long
that could take, while holding the single compile slot. One `typst` that never exits would have
blocked every later compile for good. That is now capped, and it returns a real error instead of
hanging.

### Being straight about it

I do not own a Windows machine, and a clean Windows CI runner does not reproduce the hang, so I
cannot prove this is the cause. It is the only mechanism I have found that accounts for every detail
in the report. That uncertainty is why step 4 below matters more than the rest of this page.

---

## What to do

### 1. Install the new build

Run the installer straight over what you have — no need to uninstall first.

### 2. Reproduce the original steps

A small document. Type `= Sample file`, press <kbd>Enter</kbd>, then type `== Second level`. That
second line is where it went wrong, so it is the fastest way to know.

### 3. Watch the status bar, bottom left

If a single compile runs long it now says **Compiling… still waiting on Typst** rather than just
*Compiling…*. Seeing that means the preview really is blocked rather than merely slow — say so, it
is a useful signal on its own.

Saving with <kbd>Ctrl</kbd>+<kbd>S</kbd> should keep working either way. Please try it and report
whether it does.

### 4. Send the diagnostics — this is the important one

**Help → Copy Diagnostics**, then paste into the issue. Do this whether it worked or not: a clean
run is as informative as a broken one.

Hilbert had never left any trace on Windows, because a windowed app there has no console to print
to. It now keeps a log, and this puts it on the clipboard along with which Typst and Tinymist it
found.

### 5. If the clipboard copy fails

The same content is on disk. Paste this into the Explorer address bar and attach the file:

```
%APPDATA%\hilbert\hilbert.log
```

> [!IMPORTANT]
> The diagnostics include your `PATH` and the full path to your project folder, so your Windows
> username will be in there. No file contents, nothing else personal — but have a look before
> posting to a public issue and redact anything you would rather not share.

---

## What I will be reading

So you know it is not going into a void. Every line `typst watch` emits is now recorded, and the
shape of the failure is visible at a glance:

```
[18:23:04.117] watch: started typst watch on C:\...\main.typ (pid Some(7412))
[18:23:04.402] watch: [20:23:04] compiling ...
[18:23:04.418] watch: [20:23:04] compiled successfully in 12.6 ms
[18:23:04.418] compile: served the watcher's PDF (6904 bytes) in 331 ms

[18:23:09.884] watch: [20:23:09] compiling ...
[18:23:39.885] compile: typst watch said it was compiling and never finished
               within 30s — restarting it and compiling directly
```

The gap at the bottom is the bug: an announcement with no answer. If your log instead shows every
`compiling ...` answered and the compile still feels stuck, then my explanation is wrong and the log
will point at where to look next — which is worth just as much.

---

## Still unexplained

Separate from the hang, and I have not been able to account for either.

**A two-minute compile right after reinstalling.** Nothing I found explains it. Does it still happen
on a fresh install, or was it a one-off? If it happens again, grab the diagnostics while it is
happening.

**Whether it depends on the folder.** If you copy the project somewhere plain — say
`C:\typst-test` — does the hang follow it, or go away?
