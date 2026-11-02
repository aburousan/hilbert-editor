#!/usr/bin/env python3
"""Get files back from Hilbert's History after they were deleted (issue #42).

Hilbert keeps the versions of every file it edits in its own data folder, not
in the project, so they outlive the project being deleted:

    macOS    ~/Library/Application Support/hilbert/history
    Linux    ~/.config/hilbert/history
    Windows  %APPDATA%\\hilbert\\history

This writes the newest version of each file into a new folder, keeping the
project's folder layout. It only reads Hilbert's data and never changes it.
Only files that were edited in Hilbert are there; pictures and files never
opened in Hilbert are not.

    python3 recover-from-history.py                 list the projects found
    python3 recover-from-history.py PROJECT OUTPUT  recover one project

PROJECT is the project folder as listed (or any part of it, if that matches
only one project). OUTPUT must not exist yet.
"""
import json
import os
import sys
from pathlib import Path


def history_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "hilbert" / "history"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "hilbert" / "history"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "hilbert" / "history"


def read_all(root: Path):
    """Every history file, as (workspace, relative path, newest entry)."""
    for file in root.glob("*/*.json"):
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        entries = [e for e in data.get("entries", []) if isinstance(e.get("content"), str)]
        if not entries or not data.get("workspace") or not data.get("path"):
            continue
        newest = max(entries, key=lambda e: e.get("timestamp", 0))
        yield data["workspace"], data["path"], newest, len(entries)


def main() -> int:
    root = history_dir()
    if not root.is_dir():
        print(f"No Hilbert history found at {root}")
        return 1
    found = list(read_all(root))
    projects = sorted({w for w, _, _, _ in found})
    if len(sys.argv) < 3:
        print(f"History at {root}\n")
        for project in projects:
            count = sum(1 for w, _, _, _ in found if w == project)
            print(f"  {project}   ({count} file{'s' if count != 1 else ''})")
        print("\nTo recover one:  python3 recover-from-history.py PROJECT OUTPUT")
        return 0
    wanted, out = sys.argv[1], Path(sys.argv[2])
    matches = [p for p in projects if p == wanted] or [p for p in projects if wanted in p]
    if len(matches) != 1:
        print(f"'{wanted}' matches {len(matches)} projects: " + ", ".join(matches) if matches else f"No project matches '{wanted}'.")
        return 1
    if out.exists():
        print(f"{out} already exists. Give a new folder, so nothing is written over.")
        return 1
    project = matches[0]
    written = 0
    for workspace, rel, entry, versions in found:
        if workspace != project:
            continue
        target = (out / rel).resolve()
        if not str(target).startswith(str(out.resolve())):
            continue  # a path that would leave the output folder
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(entry["content"], encoding="utf-8")
        written += 1
        print(f"  {rel}  ({versions} version{'s' if versions != 1 else ''} kept)")
    print(f"\nWrote {written} file{'s' if written != 1 else ''} from {project} into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
