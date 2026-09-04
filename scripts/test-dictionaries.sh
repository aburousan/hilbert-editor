#!/usr/bin/env bash
# Downloads a handful of the spelling dictionaries Hilbert offers and checks that
# each one actually reads its own language. The encodings differ — German and
# Polish are Latin-1 and Latin-2, not UTF-8 — and a word list decoded wrongly
# still parses, then quietly reports every accented word as a misspelling. This
# is the only test that catches that, and it needs the network, which is why it
# lives here rather than in `cargo test`.
set -euo pipefail

src="https://raw.githubusercontent.com/LibreOffice/dictionaries/master"
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="${HILBERT_DICT_DIR:-$(mktemp -d)}"
mkdir -p "$dir"
echo "dictionaries -> $dir"

fetch() { # code, upstream path without extension
  for ext in aff dic; do
    if [ ! -s "$dir/$1.$ext" ]; then
      echo "  fetching $1.$ext"
      curl -fsSL --retry 2 -o "$dir/$1.$ext" "$src/$2.$ext"
    fi
  done
}

fetch fr_FR fr_FR/dictionaries/fr
fetch de_DE de/de_DE_frami
fetch pl_PL pl_PL/pl_PL
fetch pt_BR pt_BR/pt_BR
fetch es_ES es/es_ES
fetch ru_RU ru_RU/ru_RU
fetch it_IT it_IT/it_IT

HILBERT_DICT_DIR="$dir" cargo test --manifest-path "$here/src-tauri/Cargo.toml" \
  downloaded_dictionary -- --ignored --nocapture
