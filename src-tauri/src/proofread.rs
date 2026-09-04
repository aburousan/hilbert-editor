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
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use harper_core::linting::{LintGroup, Linter, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use harper_typst::Typst;
use serde::Serialize;
use spellbook::Dictionary as SpellDict;

// Embedded en_US Hunspell dictionary (SCOWL-derived; permissive license kept
// alongside the data). Bundling it keeps English working the moment the app is
// installed; every other language is a Hunspell pair the writer downloads once
// (see `dict_catalog`), kept as plain files under `dict_dir()`.
const EN_US_AFF: &str = include_str!("dict/en_US.aff");
const EN_US_DIC: &str = include_str!("dict/en_US.dic");
pub const BUILTIN: &str = "en_US";

// Dictionaries already parsed, by language tag. Parsing costs a beat — 50k stems
// for English, considerably more for the big agglutinative languages — so each
// is parsed once and held. A `None` remembers one that would not parse, so a
// broken file isn't retried on every keystroke.
static LOADED: LazyLock<RwLock<HashMap<String, Option<Arc<SpellDict>>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

// The dictionary folder as last read, with the write time it had. Saves walking
// it on every lint — which is every pause in typing — while still noticing a
// dictionary that appears or goes away.
type InstalledCache = Option<(Option<std::time::SystemTime>, Vec<String>)>;
static INSTALLED: LazyLock<Mutex<InstalledCache>> = LazyLock::new(|| Mutex::new(None));

// Personal dictionary: words the writer chose to keep, kept per language so a
// French word doesn't quietly excuse an English typo. Loaded once from disk,
// mirrored back on every addition so it persists across sessions.
static IGNORED: LazyLock<RwLock<HashMap<String, HashSet<String>>>> =
    LazyLock::new(|| RwLock::new(load_user_dict()));
// Bumped whenever a word is ignored, so cached answers from before it are not
// reused. Cheaper than clearing the cache and safe to read from any thread.
static IGNORED_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// Suggestion cache. `spellbook.suggest()` does an edit-distance search over the
// whole dictionary (~90ms each), so we compute a word's suggestions once and
// reuse them forever. Without this, a document that repeats a misspelling N
// times paid N× the cost — the dominant source of lint latency.
static SUGGEST_CACHE: LazyLock<Mutex<HashMap<(String, String), Vec<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// Harper's full-rule LintGroup, built once per thread and reused. Constructing it
// per call (new_curated + set_all_rules_to over the whole rule set) was the
// dominant lint cost, and running many lints at once multiplied memory by
// rebuilding it every time. LintGroup isn't Send, so it can't be a shared global;
// a thread-local means each blocking-pool thread that runs lint builds it once and
// reuses it (a handful of threads, not one per request).
thread_local! {
    static LINTERS: RefCell<HashMap<Dialect, LintGroup>> = RefCell::new(HashMap::new());
}

fn with_linter<R>(dialect: Dialect, f: impl FnOnce(&mut LintGroup) -> R) -> R {
    LINTERS.with(|cell| {
        let mut map = cell.borrow_mut();
        let group = map.entry(dialect).or_insert_with(|| {
            let mut l = LintGroup::new_curated(FstDictionary::curated(), dialect);
            l.set_all_rules_to(Some(true));
            // Everything except the thesaurus rule. Its suggestions ("a livelier
            // word than `good`") are dropped further down as noise for technical
            // prose, but leaving the rule on still made harper unpack its
            // thesaurus — and in 2.8 that unpacking asks zstd for a 128 MB window
            // against a 100 MB limit and panics. That panic is what took the whole
            // editor down the moment proofreading was switched on.
            l.config.set_rule_enabled("BoringWords", false);
            l
        });
        f(group)
    })
}

// ---------------------------------------------------------------------------
// Which dictionary reads this document
// ---------------------------------------------------------------------------

/// Where downloaded dictionaries live: one `.aff` and one `.dic` per language
/// tag, alongside the licence files they came with. `HILBERT_DICT_DIR` moves
/// them elsewhere — a shared folder, a stick, or a test's scratch directory.
pub fn dict_dir() -> PathBuf {
    match std::env::var_os("HILBERT_DICT_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => user_dict_path().with_file_name("dictionaries"),
    }
}

/// A language tag we are willing to build a file path out of.
pub fn valid_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 16
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Language tags with a dictionary on hand. English is always among them.
///
/// Read on every lint, which is every pause in typing, so the directory is only
/// walked when it has actually changed. `unload` clears this along with the
/// dictionary it drops, so an install or a removal is seen at once.
pub fn installed() -> Vec<String> {
    let stamp = std::fs::metadata(dict_dir()).and_then(|m| m.modified()).ok();
    if let Some((seen, list)) = INSTALLED.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        && *seen == stamp
    {
        return list.clone();
    }
    let list = read_installed();
    *INSTALLED.lock().unwrap_or_else(|e| e.into_inner()) = Some((stamp, list.clone()));
    list
}

fn read_installed() -> Vec<String> {
    let mut out = vec![BUILTIN.to_string()];
    if let Ok(rd) = std::fs::read_dir(dict_dir()) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("dic") {
                continue;
            }
            let Some(code) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if code != BUILTIN && valid_code(code) && path.with_extension("aff").is_file() {
                out.push(code.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Forget a dictionary we have in memory — after it is removed or replaced on
/// disk, so the next document is checked against what is actually there.
pub fn unload(code: &str) {
    LOADED.write().unwrap_or_else(|e| e.into_inner()).remove(code);
    *INSTALLED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    SUGGEST_CACHE.lock().unwrap_or_else(|e| e.into_inner()).retain(|(c, _), _| c != code);
    PIECE_CACHE.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// The dictionary that should read a document tagged `lang` (an ISO 639 code)
/// in `region` (an ISO 3166 code, or empty). An exact region match wins; then
/// the language's own country (`fr` → `fr_FR`); then any dictionary for that
/// language at all. `None` means nothing installed can read it.
pub fn dictionary_for(lang: &str, region: &str) -> Option<String> {
    let lang = lang.trim().to_ascii_lowercase();
    let lang = lang.split(['-', '_']).next().unwrap_or("").to_string();
    if lang.is_empty() {
        return Some(BUILTIN.to_string());
    }
    let region = region.trim().to_ascii_uppercase();
    let have = installed();
    if !region.is_empty() {
        let exact = format!("{lang}_{region}");
        if have.iter().any(|c| *c == exact) {
            return Some(exact);
        }
    }
    // With no region to go on, in order of preference: the language's own
    // country (`fr` → `fr_FR`), the language with no country at all (`ar`), the
    // dictionary built into the application, and only then whatever else is
    // installed for that language. Anything less definite than this makes the
    // answer depend on what a writer happens to have downloaded — an English
    // document reading as Australian because that dictionary sorts first.
    let home = format!("{lang}_{}", lang.to_ascii_uppercase());
    let rank = |code: &String| match code.as_str() {
        c if c == home => 0,
        c if c == lang => 1,
        c if c == BUILTIN => 2,
        _ => 3,
    };
    have.iter()
        .filter(|code| base_lang(code) == lang)
        .min_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)))
        .cloned()
}

fn base_lang(code: &str) -> String {
    code.split('_').next().unwrap_or("").to_ascii_lowercase()
}

/// The encoding an affix file declares on its `SET` line. The line itself is
/// ASCII wherever it appears, so it can be read out of the raw bytes before we
/// know how to decode the rest of the file.
fn declared_encoding(aff: &[u8]) -> Option<String> {
    aff.split(|b| *b == b'\n').take(40).find_map(|line| {
        let line = String::from_utf8_lossy(line);
        line.strip_prefix("SET ").map(|rest| rest.trim().to_string()).filter(|s| !s.is_empty())
    })
}

/// Decode a Hunspell file. Most are UTF-8, but a good handful of the ones people
/// actually want — German, Polish, Brazilian Portuguese — are still Latin-1 or
/// Latin-2, and a word list read with the wrong encoding quietly reports every
/// accented word in the language as a misspelling.
fn decode_hunspell(bytes: &[u8], label: Option<&str>, what: &str) -> Result<String, String> {
    let named = label.and_then(|l| {
        let squashed = l.replace(['-', '_'], "").to_ascii_lowercase();
        encoding_rs::Encoding::for_label(squashed.as_bytes())
            .or_else(|| encoding_rs::Encoding::for_label(l.as_bytes()))
    });
    let enc = match named {
        Some(e) if e != encoding_rs::UTF_8 => e,
        // Nothing declared, or UTF-8 declared: take it at its word, and fall
        // back to Latin-1 for the few files that lie about it.
        _ => match std::str::from_utf8(bytes) {
            Ok(text) => return Ok(text.to_string()),
            Err(_) => encoding_rs::WINDOWS_1252,
        },
    };
    let (text, _, bad) = enc.decode(bytes);
    if bad {
        return Err(format!("{what} is not valid {}", enc.name()));
    }
    Ok(text.into_owned())
}

/// A parsed dictionary, loaded on first use and kept.
fn dictionary(code: &str) -> Option<Arc<SpellDict>> {
    if let Some(hit) = LOADED.read().unwrap_or_else(|e| e.into_inner()).get(code) {
        return hit.clone();
    }
    let parsed = if code == BUILTIN {
        SpellDict::new(EN_US_AFF, EN_US_DIC).map_err(|e| e.to_string())
    } else if !valid_code(code) {
        Err("not a language tag".to_string())
    } else {
        let base = dict_dir().join(code);
        let read = |path: PathBuf| std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()));
        read(base.with_extension("aff")).and_then(|aff_bytes| {
            let label = declared_encoding(&aff_bytes);
            let aff = decode_hunspell(&aff_bytes, label.as_deref(), "the affix file")?;
            let dic_bytes = read(base.with_extension("dic"))?;
            let dic = decode_hunspell(&dic_bytes, label.as_deref(), "the word list")?;
            SpellDict::new(&aff, &dic).map_err(|e| e.to_string())
        })
    };
    let slot = match parsed {
        Ok(d) => Some(Arc::new(d)),
        Err(e) => {
            eprintln!("[hilbert] cannot use the {code} dictionary: {e}");
            None
        }
    };
    LOADED.write().unwrap_or_else(|e| e.into_inner()).insert(code.to_string(), slot.clone());
    slot
}

// Suggestions for one word, memoized. The lock is only held around the cheap
// map ops, never across the expensive `suggest()` call.
fn suggestions_for(code: &str, dict: &SpellDict, word: &str) -> Vec<String> {
    let key = (code.to_string(), word.to_string());
    if let Some(hit) = SUGGEST_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return hit.clone();
    }
    let mut buf: Vec<String> = Vec::new();
    dict.suggest(word, &mut buf);
    buf.truncate(8);
    SUGGEST_CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(key, buf.clone());
    buf
}

/// One proofreading issue, in the shape the frontend renders directly.
#[derive(Serialize, Clone, Debug)]
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

// ---------------------------------------------------------------------------
// Only look at what changed
// ---------------------------------------------------------------------------
// A whole-document pass over a real paper costs about 740 ms — 310 ms of it
// parsing the Typst markup, most of the rest running Harper's rules — and it ran
// in full every time typing stopped, although almost nothing had changed.
//
// The document is cut into pieces at blank lines, each piece is linted alone,
// and the answers are kept under a hash of the piece. Editing one paragraph then
// costs one paragraph. A cut may only fall where a piece parses the same alone
// as it did in the document, which means never inside a fenced raw block or a
// display formula: a paragraph lifted out of a ``` fence would be read as prose
// and spell-checked line by line.

/// Byte ranges of the pieces the document splits into.
fn pieces(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut fence: Option<usize> = None;
    let mut math = false;
    let mut at = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        if let Some(ticks) = fence {
            if trimmed.starts_with(&"`".repeat(ticks)) {
                fence = None;
            }
        } else if trimmed.starts_with("```") {
            let ticks = trimmed.chars().take_while(|c| *c == '`').count();
            if trimmed.len() == ticks || !trimmed[ticks..].contains(&"`".repeat(ticks)) {
                fence = Some(ticks);
            }
        } else {
            let dollars = line
                .char_indices()
                .filter(|(i, c)| *c == '$' && (*i == 0 || !line[..*i].ends_with('\\')))
                .count();
            if dollars % 2 == 1 {
                math = !math;
            }
        }

        if trimmed.is_empty() && fence.is_none() && !math {
            if at > start {
                out.push((start, at));
            }
            start = at + line.len();
        }
        at += line.len();
    }
    if at > start {
        out.push((start, at));
    }
    out
}

/// Whether a sentence really begins at this point in the source.
///
/// Harper reports that a sentence starts in lower case. In a paper the answer
/// is usually that no sentence starts there at all:
///
/// ```text
/// $ tau_nu = integral alpha_nu dif s, $ <eq:tau>
///
/// where $alpha_nu$ is the absorption coefficient
/// ```
///
/// is one sentence with a formula set in the middle of it. So is a table cell —
/// `[per unit solid angle], [diffuse emission fills the beam]` — and so is a
/// line broken with a backslash. On a real paper this is a sixth of everything
/// the proofreader says, all of it wrong.
///
/// A sentence starts where the one before it ended, so that is what gets asked.
fn opens_no_sentence(before: &[char]) -> bool {
    let mut at = before.len();
    while at > 0 {
        match before[at - 1] {
            // Whitespace, Typst's explicit line break, and the markers around
            // emphasis — `[*the slope*` opens a table cell, not a sentence,
            // while `dominates.*` still ends one.
            c if c.is_whitespace() => at -= 1,
            '\\' | '*' | '_' => at -= 1,
            // A label belongs to whatever it labels; step over it and keep going.
            '>' => {
                let mut back = at - 1;
                while back > 0 && before[back - 1] != '<' {
                    back -= 1;
                }
                if back == 0 {
                    return false;
                }
                at = back - 1;
            }
            // Punctuation that leaves a sentence open, the opening of a content
            // block, and the close of a formula.
            c => return matches!(c, '[' | '(' | '{' | ',' | ';' | ':' | '$' | '-'),
        }
    }
    // Nothing before it at all: the top of the file is not a sentence break.
    true
}

/// Answers for pieces seen before, by hash./// Answers for pieces seen before, by hash. Bounded, so a long session editing
/// its way through a book does not keep every version of every paragraph.
static PIECE_CACHE: LazyLock<Mutex<HashMap<u64, Vec<Issue>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
const PIECE_CACHE_MAX: usize = 4096;

fn piece_hash(text: &str, how: &Reading, generation: u64) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    // The same paragraph read as French and as English is two different
    // questions, and ignoring a word changes the answer to both.
    how.dictionary.hash(&mut hasher);
    how.grammar.map(|d| d as u8).hash(&mut hasher);
    generation.hash(&mut hasher);
    hasher.finish()
}

/// How a document is to be read: which spelling dictionary, and which English
/// dialect Harper should use — `None` for a language Harper has no rules for,
/// which is every language but English.
#[derive(Clone)]
pub struct Reading {
    /// Language tag of the dictionary in use, or `None` if none is installed
    /// for this document's language.
    pub dictionary: Option<String>,
    pub grammar: Option<Dialect>,
    /// Base language of the document, as written in `#set text(lang: …)`.
    pub lang: String,
    /// The region it asked for, which may be one we have no dictionary for.
    pub region: String,
}

impl Reading {
    /// Work out how to read a document tagged `lang` / `region`.
    pub fn of(lang: &str, region: &str) -> Reading {
        let lang = lang.trim().to_ascii_lowercase();
        let lang = lang.split(['-', '_']).next().unwrap_or("en").to_string();
        let lang = if lang.is_empty() { "en".to_string() } else { lang };
        let region = region.trim().to_ascii_uppercase();
        // Harper's rules and its part-of-speech model are English-only; running
        // them over French prose produces confident nonsense, so grammar simply
        // switches off outside English.
        let grammar = (lang == "en").then(|| match region.as_str() {
            "GB" | "UK" | "IE" | "NZ" => Dialect::British,
            "AU" => Dialect::Australian,
            "CA" => Dialect::Canadian,
            "IN" => Dialect::Indian,
            _ => Dialect::American,
        });
        Reading { dictionary: dictionary_for(&lang, &region), grammar, lang, region }
    }
}

/// Lint `text` as a Typst document, returning spelling + grammar/style issues
/// sorted by position.
pub fn lint(text: &str, how: &Reading) -> Vec<Issue> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let generation = IGNORED_GENERATION.load(std::sync::atomic::Ordering::Relaxed);
    let cuts = pieces(text);

    // Parsing a document once is much cheaper than parsing each of its
    // paragraphs, so a document nobody has seen before goes through in one
    // piece — and its answers are then filed under the paragraphs they came
    // from, which is what makes the next pass cost one paragraph.
    let known = {
        let cache = PIECE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cuts.iter().filter(|(from, to)| cache.contains_key(&piece_hash(&text[*from..*to], how, generation))).count()
    };
    if cuts.len() > 4 && known * 2 < cuts.len() {
        let whole = lint_piece(text, how);
        let mut cache = PIECE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() + cuts.len() >= PIECE_CACHE_MAX {
            cache.clear();
        }
        let mut at = 0usize; // characters consumed up to the start of this piece
        let mut rest = whole.as_slice();
        for (from, to) in &cuts {
            let piece = &text[*from..*to];
            let shift = text[..*from].chars().count();
            let len = piece.chars().count();
            // Issues are sorted, so walk them alongside the pieces.
            let taken = rest.iter().take_while(|i| i.start < shift + len).count();
            let (mine, tail) = rest.split_at(taken);
            rest = tail;
            let owned: Vec<Issue> = mine
                .iter()
                .filter(|i| i.start >= shift && i.end <= shift + len)
                .map(|i| Issue { start: i.start - shift, end: i.end - shift, ..i.clone() })
                .collect();
            cache.insert(piece_hash(piece, how, generation), owned);
            at = shift + len;
        }
        let _ = at;
        return without_false_sentence_starts(whole, text);
    }

    let mut out: Vec<Issue> = Vec::new();
    for (from, to) in cuts.iter().copied() {
        let piece = &text[from..to];
        if piece.trim().is_empty() {
            continue;
        }
        let key = piece_hash(piece, how, generation);
        let cached = PIECE_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key).cloned();
        let found = match cached {
            Some(hit) => hit,
            None => {
                let fresh = lint_piece(piece, how);
                let mut cache = PIECE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
                if cache.len() >= PIECE_CACHE_MAX {
                    cache.clear();
                }
                cache.insert(key, fresh.clone());
                fresh
            }
        };
        // Offsets come back relative to the piece; the caller wants them in the
        // document. Both are counted in characters, not bytes.
        let shift = text[..from].chars().count();
        out.extend(found.into_iter().map(|issue| Issue {
            start: issue.start + shift,
            end: issue.end + shift,
            ..issue
        }));
    }
    out.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
    without_false_sentence_starts(out, text)
}

/// Drop the complaints that a sentence starts in lower case where no sentence
/// starts at all. Harper's `Capitalization` rule covers other things too — the
/// canonical spelling of an acronym, for one — so the message has to match as
/// well as the rule.
fn without_false_sentence_starts(issues: Vec<Issue>, text: &str) -> Vec<Issue> {
    if !issues.iter().any(|issue| issue.message.contains("capital letter")) {
        return issues;
    }
    let chars: Vec<char> = text.chars().collect();
    issues
        .into_iter()
        .filter(|issue| {
            !(issue.rule.contains("Capitalization")
                && issue.message.contains("capital letter")
                && issue.start <= chars.len()
                && opens_no_sentence(&chars[..issue.start]))
        })
        .collect()
}

/// Lint one self-contained stretch of a document. Callers go through `lint`,
/// which cuts the document up and keeps the answers.
fn lint_piece(text: &str, how: &Reading) -> Vec<Issue> {
    let mut issues: Vec<Issue> = Vec::new();
    if text.trim().is_empty() {
        return issues;
    }

    let ignored = IGNORED
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(&how.lang)
        .cloned()
        .unwrap_or_default();

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
    if let Some(dict) = how.dictionary.as_deref().and_then(dictionary) {
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
            // Acronyms and names written in code style — CMB, LaTeX, arXiv — are
            // the bulk of what a general dictionary gets wrong about technical
            // prose, and no word list will ever hold them all. Word processors
            // have skipped them by default for decades; so do we.
            if is_shouted(&word) || is_camel_case(&word) {
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
    // Harper reads English only, in one of the dialects it knows. Outside
    // English there is nothing honest for it to say, so it stays quiet and the
    // panel tells the writer that only spelling is being checked. The repeated
    // word check below is language-independent and still runs.
    let lints = match how.grammar {
        Some(dialect) => with_linter(dialect, |l| l.lint(&doc)),
        None => Vec::new(),
    };
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
        // Two tokens that overlap, or arrive out of order, would make the slice
        // below run backwards and take the whole editor down with it — the
        // release build turns a panic into an abort. Nothing in the tokenizer
        // is supposed to produce that; this is here because the linter reads
        // whatever anyone happens to type.
        if b.0 < a.1 || b.1 > source.len() {
            continue;
        }
        // Require true adjacency: only whitespace between them (so "play. Play"
        // across a sentence boundary isn't flagged), and not across a blank
        // line — a paragraph ending on the word the next one opens with is not
        // a typo, and it is also the one thing a piece read on its own could
        // not see.
        let between: String = source[a.1..b.0].iter().collect();
        if between.chars().any(|c| !c.is_whitespace()) || between.contains("\n\n") {
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
    let _ = dictionary(BUILTIN);
    let _ = lint("The quick brown fox jumps over the lazy dog.", &Reading::of("en", ""));
}

/// Spelling suggestions for a batch of words (memoized). Fetched lazily by the
/// client for the misspellings it actually shows, so the cost never lands on
/// the per-edit lint path. Capped so one request can't stall for too long.
pub fn suggest_words(words: &[String], how: &Reading) -> Vec<(String, Vec<String>)> {
    let Some(code) = how.dictionary.as_deref() else { return Vec::new() };
    let Some(dict) = dictionary(code) else { return Vec::new() };
    words
        .iter()
        .take(80)
        .map(|w| (w.clone(), suggestions_for(code, &dict, w)))
        .collect()
}

/// Add a word to the personal dictionary for one language, so it is no longer
/// flagged when writing in that language.
pub fn add_ignored_word(word: &str, lang: &str) {
    let w = word.trim().to_lowercase();
    let lang = base_lang(if lang.trim().is_empty() { "en" } else { lang });
    if w.is_empty() {
        return;
    }
    {
        let mut g = IGNORED.write().unwrap_or_else(|e| e.into_inner());
        if !g.entry(lang.clone()).or_default().insert(w.clone()) {
            return; // already present
        }
        IGNORED_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    let path = user_dict_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{lang}\t{w}");
    }
}

/// Written entirely in capitals — an acronym, a unit symbol, an instrument
/// name. Two letters and up, so "I" and "A" stay ordinary words.
fn is_shouted(word: &str) -> bool {
    let mut letters = 0;
    for c in word.chars() {
        if c.is_alphabetic() {
            if c.is_lowercase() {
                return false;
            }
            letters += 1;
        }
    }
    letters >= 2
}

/// A capital after the first letter — LaTeX, arXiv, McDonald, JavaScript. Names
/// and identifiers rather than words a dictionary should be asked about.
fn is_camel_case(word: &str) -> bool {
    word.chars().skip(1).any(char::is_uppercase)
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

/// Read the personal dictionary: `lang<TAB>word` per line. Lines from before
/// the file grew a language column are read as English, which is what they were.
fn load_user_dict() -> HashMap<String, HashSet<String>> {
    let mut out: HashMap<String, HashSet<String>> = HashMap::new();
    let Ok(text) = std::fs::read_to_string(user_dict_path()) else { return out };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (lang, word) = match line.split_once('\t') {
            Some((l, w)) => (base_lang(l), w.trim().to_lowercase()),
            None => ("en".to_string(), line.to_lowercase()),
        };
        if !word.is_empty() {
            out.entry(lang).or_default().insert(word);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The linter runs over whatever the writer happens to have typed, and a
    // panic in it takes the whole editor with it. These are the shapes that
    // reach it in practice: scripts it has no rules for, formulas, code, and
    // the half-finished markup of something being written.
    #[test]
    fn lint_survives_awkward_documents() {
        let cases = [
            "The the quick brown fox.",
            "שלום עולם, this is mixed עברית and English.",
            "مرحبا بالعالم with English after it.",
            "$ I_nu = kappa_0 (nu\\/nu_0)^beta Sigma B_nu (T). $ <eq:mbb>",
            "#set text(lang: \"en\")\n#let x = 3\nSome prose after code.",
            "A person once said \\\"Please give me a fish\\\".",
            "emoji 🎉🎉 and combining é and ﬁ ligature",
            "don't can't won't it's o'clock rock'n'roll",
            "a a a a a b b b b",
            "Word\u{200f}with\u{200e}bidi marks inside",
            "trailing spaces    \n\n\n   leading",
            "Ünïcödé wörds with ÄÖÜ and ß and ıİ",
            "hyphen-ated compound-word test-case here",
            "1.5--1.8, 10^(-26), 58.8 GHz, x_\"pk\"",
            "```python\nprint(\"hello\")\n```\nprose after a code block",
            "= Heading <label>\n\nBody text under it.",
        ];
        for case in cases {
            let issues = lint(case, &Reading::of("en", ""));
            // Every span the linter reports has to be a real slice of the text
            // it was given, or the editor will underline the wrong words.
            let chars = case.chars().count();
            for issue in &issues {
                assert!(issue.start <= issue.end,
                    "reversed span in {case:?}: {}..{} {:?}", issue.start, issue.end, issue.text);
                assert!(issue.end <= chars,
                    "span past the end of {case:?}: {}..{} {:?}", issue.start, issue.end, issue.text);
            }
        }
    }

    #[test]
    fn lint_survives_a_long_technical_document() {
        // Something the size of a real paper, with the mixture that goes with it.
        let mut text = String::new();
        for section in 0..40 {
            text.push_str(&format!("= Section {section} <sec:{section}>\n\n"));
            text.push_str("The dust temperature is measured here, and the the emissivity follows.\n\n");
            text.push_str("$ tau_nu = kappa_nu times Sigma, $ <eq:kappa>\n\n");
            text.push_str("#set text(font: \"New Computer Modern\")\n\n");
            text.push_str("שלום עולם in the middle of a paragraph.\n\n");
        }
        let issues = lint(&text, &Reading::of("en", ""));
        assert!(!issues.is_empty(), "a document this size should raise something");
    }
}

// Reading a downloaded dictionary is the part that can go wrong quietly: a
// Hunspell pair that parses but was decoded in the wrong encoding reports every
// accented word in the language as a misspelling, and looks fine until someone
// writes in French. These need the actual files, so they are off by default;
// `scripts/test-dictionaries.sh` fetches them and runs this.
#[cfg(test)]
mod downloaded_dictionary_tests {
    use super::*;

    fn have(code: &str) -> bool {
        dict_dir().join(format!("{code}.dic")).is_file()
    }

    #[test]
    #[ignore = "needs downloaded dictionaries; see scripts/test-dictionaries.sh"]
    fn downloaded_dictionaries_read_their_own_language() {
        // Word, and a misspelling of it, in each language's own script and
        // accents — the pair that separates "the dictionary works" from "the
        // dictionary loaded".
        let cases: &[(&str, &str, &str)] = &[
            ("fr_FR", "déjà", "déjuà"),
            ("de_DE", "Grüße", "Grüpße"),
            ("pl_PL", "źdźbło", "źdźbwło"),
            ("pt_BR", "coração", "coraçãro"),
            ("es_ES", "año", "añro"),
            ("ru_RU", "здравствуйте", "здраввствуйте"),
            ("it_IT", "perché", "perchéé"),
        ];
        let mut checked = 0;
        for (code, good, bad) in cases {
            if !have(code) {
                continue;
            }
            let dict = dictionary(code).unwrap_or_else(|| panic!("{code} would not load"));
            assert!(dict.check(good), "{code}: {good} should be a word");
            assert!(!dict.check(bad), "{code}: {bad} should not be a word");
            checked += 1;
        }
        assert!(checked > 0, "no dictionaries to test — run scripts/test-dictionaries.sh");
    }

    #[test]
    #[ignore = "needs downloaded dictionaries; see scripts/test-dictionaries.sh"]
    fn a_french_document_is_checked_in_french() {
        if !have("fr_FR") {
            return;
        }
        let how = Reading::of("fr", "");
        assert_eq!(how.dictionary.as_deref(), Some("fr_FR"), "French should pick the French dictionary");
        assert!(how.grammar.is_none(), "Harper has no French rules and should stay quiet");
        let text = "Le ciel est bleu et les étoiles sont brillantes.";
        assert!(lint(text, &how).is_empty(), "correct French should read clean");
        let issues = lint("Le ciel est bleuu.", &how);
        assert!(issues.iter().any(|i| i.text == "bleuu"), "the misspelling should be caught: {issues:?}");
    }
}

#[cfg(test)]
mod continuation_tests {
    use super::*;

    #[test]
    fn prose_carrying_on_after_an_equation_is_left_alone() {
        // One sentence with a formula set in the middle of it. The `where` is
        // where the sentence continues, not where a new one starts badly.
        let how = Reading::of("en", "");
        let text = "\
= A section

The optical depth is defined by

$ tau_nu = integral alpha_nu dif s, $ <eq:tau>

where $alpha_nu$ is the absorption coefficient and the integral runs along the
path through the cloud.
";
        let complaints: Vec<String> = lint(text, &how)
            .into_iter()
            .filter(|issue| issue.message.contains("capital letter"))
            .map(|issue| issue.text)
            .collect();
        assert!(complaints.is_empty(), "should not complain about {complaints:?}");
    }

    #[test]
    fn a_paragraph_that_really_does_start_badly_is_still_flagged() {
        let how = Reading::of("en", "");
        let text = "\
= A section

The optical depth is defined along the path through the cloud.

the next paragraph opens in lower case after a finished sentence.
";
        let found = lint(text, &how);
        assert!(found.iter().any(|i| i.message.contains("capital letter")),
            "a genuine lower-case opening should still be reported: {found:?}");
    }

    fn opens(before: &str) -> bool {
        let chars: Vec<char> = before.chars().collect();
        opens_no_sentence(&chars)
    }

    #[test]
    fn a_sentence_starts_only_where_the_last_one_ended() {
        // No sentence starts here.
        assert!(opens("some prose ending in a comma,\n\n"));
        assert!(opens("$ a = b $ <eq:one>\n\n"));
        assert!(opens("$ a = b $\n\n"));
        assert!(opens("[per unit area], ["));
        assert!(opens("what an SED is, \\\n  "));
        assert!(opens("#figure(caption: ["));
        assert!(opens("[$epsilon_nu$], [*"));
        // Emphasis is transparent, so the full stop behind it still counts.
        assert!(!opens("*This dominates.* "));
        // One does.
        assert!(!opens("a finished sentence.\n\n"));
        assert!(!opens("a question?\n\n"));
        assert!(!opens("an exclamation!\n\n"));
        assert!(!opens("a word"));
    }
}

#[cfg(test)]
mod reading_tests {
    use super::*;

    #[test]
    fn english_is_always_readable_and_brings_its_grammar() {
        // The built-in dictionary, whatever else the writer has downloaded —
        // an English document must not start reading as Australian because
        // that dictionary happens to sort first.
        let how = Reading::of("en", "");
        assert_eq!(how.dictionary.as_deref(), Some(BUILTIN));
        assert_eq!(how.grammar, Some(Dialect::American));
    }

    #[test]
    fn the_region_chooses_the_dialect() {
        for (region, dialect) in [
            ("GB", Dialect::British),
            ("IE", Dialect::British),
            ("AU", Dialect::Australian),
            ("CA", Dialect::Canadian),
            ("IN", Dialect::Indian),
            ("US", Dialect::American),
            ("", Dialect::American),
        ] {
            assert_eq!(Reading::of("en", region).grammar, Some(dialect), "region {region}");
        }
    }

    #[test]
    fn a_language_we_cannot_read_is_admitted_rather_than_guessed() {
        // A tag no dictionary answers to — the test must not depend on which
        // real languages the machine running it happens to have installed.
        // A document in it comes back with nothing to check, rather than with
        // the English dictionary's opinion of it, which would be that every
        // other word is misspelled.
        let how = Reading::of("zz", "");
        assert!(how.dictionary.is_none(), "an unknown language should not fall back to English");
        assert!(how.grammar.is_none(), "Harper only has English rules");
        assert!(lint("Le ciel est bleu ce soir.", &how).is_empty());
    }

    #[test]
    fn a_language_tag_is_read_the_way_typst_writes_it() {
        assert_eq!(Reading::of("EN", "gb").lang, "en");
        assert_eq!(Reading::of("EN", "gb").grammar, Some(Dialect::British));
        assert_eq!(Reading::of("en-GB", "").lang, "en");
        assert_eq!(Reading::of("", "").lang, "en");
    }

    // The vocabulary of a particular field is the bulk of what a general
    // dictionary gets wrong, and no word list will ever hold it.
    #[test]
    fn acronyms_and_code_style_names_are_not_asked_about() {
        let how = Reading::of("en", "");
        let text = "The CMB map from HEALPix went through LaTeX and arXiv, then a genuine typpo.";
        let flagged: Vec<String> = lint(text, &how)
            .into_iter()
            .filter(|i| i.kind == "spelling")
            .map(|i| i.text)
            .collect();
        assert_eq!(flagged, vec!["typpo".to_string()], "got {flagged:?}");
    }

    #[test]
    fn ordinary_misspellings_are_still_caught() {
        let how = Reading::of("en", "");
        let flagged: Vec<String> = lint("The quick brown fox jumpps over the lazy dog.", &how)
            .into_iter()
            .filter(|i| i.kind == "spelling")
            .map(|i| i.text)
            .collect();
        assert_eq!(flagged, vec!["jumpps".to_string()]);
    }
}

#[cfg(test)]
mod incremental_tests {
    use super::*;

    // Cutting the document up must not change what the checker finds. The pieces
    // are linted alone; if a cut fell inside a code fence or a display formula,
    // that piece would be read as prose and this would show it.
    #[test]
    fn pieces_find_what_the_whole_document_finds() {
        let text = "\
#set text(lang: \"en\")

A paragraph with a mispeling in it.

```python
# teh comment inside a fence is not prose
print(\"hello\")
```

$
  I_nu = kappa_0 (nu\\/nu_0)^beta Sigma B_nu (T).
$

Another paragraph, with an the double article.

= A heading <sec:one>

Final paragraph mentioning teh same typo twice, teh same typo.
";
        let how = Reading::of("en", "");
        let whole = lint_piece(text, &how);
        let chunked = lint(text, &how);
        let key = |list: &Vec<Issue>| {
            let mut v: Vec<(usize, usize, String)> =
                list.iter().map(|i| (i.start, i.end, i.text.clone())).collect();
            v.sort();
            v
        };
        assert_eq!(key(&chunked), key(&whole),
            "piece-wise lint disagreed with the whole-document lint");
    }

    #[test]
    fn a_cut_never_falls_inside_a_block() {
        let text = "one\n\n```\nfenced\n\nstill fenced\n```\n\ntwo\n\n$\n  a\n\n  b\n$\n\nthree\n";
        let cuts = pieces(text);
        for (from, to) in &cuts {
            let piece = &text[*from..*to];
            assert_eq!(piece.matches("```").count() % 2, 0,
                "a piece ended inside a fence: {piece:?}");
        }
        // The fenced block and the formula each stay in one piece.
        assert!(cuts.iter().any(|(f, t)| text[*f..*t].contains("still fenced")
            && text[*f..*t].starts_with("```")));
        assert!(cuts.iter().any(|(f, t)| text[*f..*t].starts_with('$')
            && text[*f..*t].contains("  b")));
    }
}

