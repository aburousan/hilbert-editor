// Native proofreading for the Tauri backend.
//
//   * Spelling  — `spellbook`, a pure-Rust spell checker that reads standard
//     Nuspell/Hunspell dictionaries. We embed the SCOWL-derived en_US
//     dictionary (see `dict/LICENSE-en_US.txt`) straight into the binary, so
//     spell checking works offline with no extra files to ship.
//   * Grammar & style — `harper-core` with `harper-typst`, a Typst-aware
//     parser. Harper reads the document as Typst, so it only lints prose and
//     leaves code, math, and markup alone.
//
// Both stages share one parse of the document, and both report issues in the
// same shape: character offsets into the *source* string (Unicode scalar
// indices) plus a list of replacement strings the UI can offer.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, RwLock};

use harper_core::linting::{LintGroup, Linter, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use harper_typst::Typst;
use serde::Serialize;
use spellbook::Dictionary as SpellDict;

// Embedded en_US Hunspell dictionary (SCOWL-derived; permissive license kept
// alongside the data). Bundling it in the binary keeps the app self-contained.
const EN_US_AFF: &str = include_str!("dict/en_US.aff");
const EN_US_DIC: &str = include_str!("dict/en_US.dic");

// Parsing the dictionary (~50k stems) takes a beat, so do it once, lazily.
static SPELL: LazyLock<Option<SpellDict>> = LazyLock::new(|| match SpellDict::new(EN_US_AFF, EN_US_DIC) {
    Ok(d) => Some(d),
    Err(e) => {
        eprintln!("[hilbert] failed to load en_US spelling dictionary: {e}");
        None
    }
});

// Personal dictionary: words the user chose to ignore. Loaded once from disk,
// mirrored back on every addition so it persists across sessions.
static IGNORED: LazyLock<RwLock<HashSet<String>>> = LazyLock::new(|| RwLock::new(load_user_dict()));

// Suggestion cache. `spellbook.suggest()` does an edit-distance search over the
// whole dictionary (~90ms each), so we compute a word's suggestions once and
// reuse them forever. Without this, a document that repeats a misspelling N
// times paid N× the cost — the dominant source of lint latency.
static SUGGEST_CACHE: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

// Harper's full-rule LintGroup, built once per thread and reused. Constructing it
// per call (new_curated + set_all_rules_to over the whole rule set) was the
// dominant lint cost, and running many lints at once multiplied memory by
// rebuilding it every time. LintGroup isn't Send, so it can't be a shared global;
// a thread-local means each blocking-pool thread that runs lint builds it once and
// reuses it (a handful of threads, not one per request).
thread_local! {
    static LINTER: RefCell<LintGroup> = RefCell::new({
        let mut l = LintGroup::new_curated(FstDictionary::curated(), Dialect::American);
        l.set_all_rules_to(Some(true));
        l
    });
}

// Suggestions for one word, memoized. The lock is only held around the cheap
// map ops, never across the expensive `suggest()` call.
fn suggestions_for(dict: &SpellDict, word: &str) -> Vec<String> {
    if let Some(hit) = SUGGEST_CACHE.lock().unwrap().get(word) {
        return hit.clone();
    }
    let mut buf: Vec<String> = Vec::new();
    dict.suggest(word, &mut buf);
    buf.truncate(8);
    SUGGEST_CACHE.lock().unwrap().insert(word.to_string(), buf.clone());
    buf
}

/// One proofreading issue, in the shape the frontend renders directly.
#[derive(Serialize)]
pub struct Issue {
    /// Char offsets into the source (Unicode scalar indices): start inclusive,
    /// end exclusive.
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub message: String,
    /// One of `"spelling"`, `"grammar"`, or `"style"`.
    pub kind: String,
    pub rule: String,
    /// Replacements for the [start, end) range; an empty string means "delete it".
    pub suggestions: Vec<String>,
}

/// Lint `text` as a Typst document, returning spelling + grammar/style issues
/// sorted by position.
pub fn lint(text: &str) -> Vec<Issue> {
    let mut issues: Vec<Issue> = Vec::new();
    if text.trim().is_empty() {
        return issues;
    }

    let ignored = IGNORED.read().unwrap().clone();

    // One parse of the Typst document, reused for spelling and grammar.
    let doc = Document::new_curated(text, &Typst);
    let source: &[char] = doc.get_source();

    // Spans already claimed by a spelling issue, so grammar rules that fire on
    // the same misspelled word (e.g. Harper's "teh -> the") don't double up.
    let mut spelled: HashSet<(usize, usize)> = HashSet::new();

    // Spelling, via spellbook (Nuspell-compatible).
    // Only `check()` runs here (fast); `suggest()` is expensive, so it's fetched
    // lazily by the client via `suggest_words` and left empty on this pass. That
    // keeps lint latency independent of how many misspellings a document has.
    if let Some(dict) = SPELL.as_ref() {
        for token in doc.tokens() {
            if !token.kind.is_word() {
                continue;
            }
            let (s, e) = (token.span.start, token.span.end);
            if e > source.len() || e <= s {
                continue;
            }
            let word: String = source[s..e].iter().collect();
            // Skip trivial / non-lexical tokens: single letters, anything with a
            // digit (units, identifiers), so we don't nag about "x" or "h2".
            if word.chars().count() < 2 || word.chars().any(|c| c.is_ascii_digit()) {
                continue;
            }
            if dict.check(&word) || ignored.contains(&word.to_lowercase()) {
                continue;
            }
            spelled.insert((s, e));
            issues.push(Issue {
                start: s,
                end: e,
                text: word.clone(),
                message: format!("\u{201c}{word}\u{201d} may be misspelled."),
                kind: "spelling".into(),
                rule: "spelling".into(),
                suggestions: Vec::new(),
            });
        }
    }

    // Grammar & style, via Harper (full rule set — see LINTER above). Its spelling
    // rules are dropped below (spellbook owns spelling), and the rest are split into
    // grammar vs style for the UI.
    let lints = LINTER.with(|cell| cell.borrow_mut().lint(&doc));
    for lint in lints {
        // Harper has its own spell checker; we defer spelling to spellbook, so
        // drop Harper's spelling lints to avoid double-flagging.
        let kind_dbg = format!("{:?}", lint.lint_kind);
        if kind_dbg.contains("Spell") {
            continue;
        }
        // Drop opinionated readability/vocabulary nags that are noise for the
        // precise, technical prose this editor targets: "spell out numbers less
        // than ten" (which even fires on `#set …numbering: "1."`) and Harper's
        // thesaurus "boring word" suggestions.
        if kind_dbg.contains("Readability") || kind_dbg.contains("Enhancement") {
            continue;
        }
        let (s, e) = (lint.span.start, lint.span.end);
        if spelled.contains(&(s, e)) {
            continue; // already flagged as a misspelling
        }
        // Don't proofread Typst configuration lines — their string arguments
        // (numbering patterns, font names, …) are code, not prose.
        if on_code_line(source, s) {
            continue;
        }
        let text: String = if e <= source.len() && e >= s { source[s..e].iter().collect() } else { String::new() };
        let suggestions = lint.suggestions.iter().map(|sg| render_suggestion(sg, &text)).collect();
        issues.push(Issue {
            start: s,
            end: e,
            text,
            message: lint.message,
            kind: classify(&kind_dbg).into(),
            rule: kind_dbg,
            suggestions,
        });
    }

    // Catch any adjacent duplicated word ourselves.
    // Harper's repetition rule only covers a curated handful of words (the,
    // a, …), so "play play" slips through. Adjacent identical words are almost
    // always a typo; flag them all, minus a few legitimate doublings.
    const DOUBLE_OK: &[&str] = &["had", "that"];
    let words: Vec<(usize, usize, String)> = doc
        .tokens()
        .filter(|t| t.kind.is_word())
        .filter_map(|t| {
            let (s, e) = (t.span.start, t.span.end);
            (e <= source.len() && e > s).then(|| (s, e, source[s..e].iter().collect::<String>()))
        })
        .collect();
    for pair in words.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        // Require true adjacency: only whitespace between them (so "play. Play"
        // across a sentence boundary isn't flagged).
        if source[a.1..b.0].iter().any(|c| !c.is_whitespace()) {
            continue;
        }
        let wa = a.2.to_lowercase();
        if wa != b.2.to_lowercase() || wa.chars().count() < 2 || DOUBLE_OK.contains(&wa.as_str()) {
            continue;
        }
        let (s, e) = (a.0, b.1);
        if on_code_line(source, s) || issues.iter().any(|i| i.start <= s && i.end >= e && i.rule == "Repetition") {
            continue; // Harper already caught this one
        }
        issues.push(Issue {
            start: s,
            end: e,
            text: source[s..e].iter().collect(),
            message: format!("Repeated word \u{201c}{}\u{201d}.", b.2),
            kind: "grammar".into(),
            rule: "Repetition".into(),
            suggestions: vec![b.2.clone()],
        });
    }

    issues.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
    issues
}

/// Warm the dictionaries and POS model so the user's first lint isn't slow.
/// Loading the 50k-word spelling dictionary and Harper's model takes a few
/// seconds; doing it here (off a background thread at launch) hides that.
pub fn warm() {
    let _ = SPELL.as_ref();
    let _ = lint("The quick brown fox jumps over the lazy dog.");
}

/// Spelling suggestions for a batch of words (memoized). Fetched lazily by the
/// client for the misspellings it actually shows, so the cost never lands on
/// the per-edit lint path. Capped so one request can't stall for too long.
pub fn suggest_words(words: &[String]) -> Vec<(String, Vec<String>)> {
    let Some(dict) = SPELL.as_ref() else { return Vec::new() };
    words
        .iter()
        .take(80)
        .map(|w| (w.clone(), suggestions_for(dict, w)))
        .collect()
}

/// Add a word to the personal dictionary so it is no longer flagged.
pub fn add_ignored_word(word: &str) {
    let w = word.trim().to_lowercase();
    if w.is_empty() {
        return;
    }
    {
        let mut g = IGNORED.write().unwrap();
        if !g.insert(w.clone()) {
            return; // already present
        }
    }
    let path = user_dict_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{w}");
    }
}

/// Turn a Harper suggestion into the replacement string for the flagged range.
/// An empty string means "remove the range".
fn render_suggestion(s: &Suggestion, offending: &str) -> String {
    match s {
        Suggestion::ReplaceWith(chars) => chars.iter().collect(),
        Suggestion::InsertAfter(chars) => {
            let mut out = offending.to_string();
            out.extend(chars.iter());
            out
        }
        Suggestion::Remove => String::new(),
    }
}

/// Bucket a Harper `LintKind` (via its Debug name) into a coarse UI category.
// Is the char at `offset` on a Typst set/let/import/show/include line? Those
// are configuration, so their contents shouldn't be proofread as prose.
fn on_code_line(source: &[char], offset: usize) -> bool {
    let mut i = offset.min(source.len());
    while i > 0 && source[i - 1] != '\n' {
        i -= 1;
    }
    while i < source.len() && (source[i] == ' ' || source[i] == '\t') {
        i += 1;
    }
    let prefix: String = source[i..(i + 9).min(source.len())].iter().collect();
    ["#set ", "#let ", "#import", "#show ", "#include"].iter().any(|p| prefix.starts_with(p))
}

fn classify(kind_dbg: &str) -> &'static str {
    // Only genuinely stylistic categories go to "style"; usage/word-choice
    // mistakes (could of → have, its/it's) read as grammar to most writers.
    const STYLE: &[&str] = &["Style", "Readability", "Enhancement", "Redundancy", "Regionalism"];
    if STYLE.iter().any(|k| kind_dbg.contains(k)) {
        "style"
    } else {
        "grammar"
    }
}

fn user_dict_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
        .join("hilbert")
        .join("user-dictionary.txt")
}

fn load_user_dict() -> HashSet<String> {
    std::fs::read_to_string(user_dict_path())
        .map(|s| s.lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}
