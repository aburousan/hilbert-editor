//! Where a point in the preview was written.
//!
//! A PDF keeps no record of the source behind its text, so double-clicking the
//! preview used to find its way back by matching words. Prose reuses its words,
//! so the match went to whichever copy of the word sat in the open file: on a
//! three-file test project 29% of double-clicks landed on the word clicked, and
//! not one written in an included chapter did.
//!
//! Typst does keep that record, in the laid-out document, where every glyph
//! carries the span of the source it was shaped from. So the document is laid
//! out again here, the way `typst compile` lays it out — the same root, fonts
//! gathered in the same order, packages from the same directories, the same
//! date and features — and the glyph under the pointer names the file and byte
//! it came from.

use std::any::Any;
use std::io::{self, Read};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;
use std::time::SystemTime;

use typst::comemo;
use typst::diag::FileResult;
use typst::foundations::{Bytes, Datetime, Duration};
use typst::introspection::{Location, Tag};
use typst::layout::{Abs, Frame, FrameItem, Point, Size};
use typst::model::{CiteElem, RefElem};
use typst::syntax::{FileId, RootedPath, Source, Span, SyntaxKind, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, Glyph, TextItem};
use typst::utils::LazyHash;
use typst::visualize::{FillRule, Geometry};
use typst::{Feature, Library, LibraryExt, World};
use typst_kit::datetime::Time;
use typst_kit::downloader::Downloader;
use typst_kit::files::{FileLoader, FileStore, FsRoot};
use typst_kit::fonts::{self, FontStore};
use typst_kit::packages::{FsPackages, SystemPackages, UniversePackages};
use typst_layout::PagedDocument;
use unicode_normalization::UnicodeNormalization;

/// What the preview shows of the page that was clicked, so that a layout which
/// is not the one on screen is caught rather than read against the click.
pub struct Shown {
    pub pages: usize,
    pub width: f64,
    pub height: f64,
    /// The run of text pdf.js draws under the pointer. See [`disagreement`].
    pub expect: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Jump {
    /// A byte in a project file, with its line and column counted the way the
    /// editor counts them: from one, in UTF-16 code units.
    Source { path: String, offset: usize, line: usize, column: usize },
    /// The glyph came from inside a package, which is not the writer's to edit.
    Package { package: String, path: String },
    /// Nothing with a place in the source is under the pointer.
    Nothing,
    /// The page laid out here is not the page on screen, even after compiling
    /// afresh: most often a preview that has not caught up with an edit yet,
    /// otherwise a `typst` on PATH that lays pages out differently.
    LayoutDiffers(String),
    /// The document does not compile, so there is nothing to look inside.
    Failed(String),
}

/// Finds what was written at `(x, y)`, in points from the top-left corner of
/// `page` (counted from one), in the document `main` compiled from `root`.
pub fn jump(root: &Path, main: &Path, page: usize, x: f64, y: f64, shown: Option<Shown>) -> Jump {
    CLICKED.store(true, std::sync::atomic::Ordering::Relaxed);
    let mut session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let (mut document, _) = match layout(&mut session, root, main, false) {
        Ok(found) => found,
        Err(message) => return Jump::Failed(message),
    };
    if let Some(shown) = &shown
        && let Some(reason) = wrong_shape(&document, page, shown)
    {
        return Jump::LayoutDiffers(reason);
    }

    let click = Point::new(Abs::pt(x), Abs::pt(y));
    let mut hit = session.as_ref().and_then(|s| found_at(s, &document, page, click));

    // What the preview draws under the pointer settles whether this layout is
    // the one on screen. An edit that keeps the page's size — most edits — moves
    // the text under a coordinate without changing anything a page-level check
    // could see, and then the click would be read against the wrong line.
    if let Some(shown) = &shown
        && let Some(expected) = shown.expect.as_deref()
    {
        let mut disagrees = disagreement(&hit, expected);
        // A file can change without its time changing, on filesystems that keep
        // times coarsely, and a font can be replaced without the source moving
        // at all, so a layout that disagrees is done again from scratch — fonts
        // and all — once before being written off.
        if disagrees.is_some() {
            match layout(&mut session, root, main, true) {
                Ok((fresh, _)) => document = fresh,
                Err(message) => return Jump::Failed(message),
            }
            if let Some(reason) = wrong_shape(&document, page, shown) {
                return Jump::LayoutDiffers(reason);
            }
            hit = session.as_ref().and_then(|s| found_at(s, &document, page, click));
            disagrees = disagreement(&hit, expected);
        }
        if let Some(reason) = disagrees {
            return Jump::LayoutDiffers(reason);
        }
    }

    let Some(session) = session.as_ref() else { return Jump::Nothing };
    match hit {
        Some(hit) => locate(&session.world, hit.id, hit.offset),
        None => Jump::Nothing,
    }
}

struct Hit {
    id: FileId,
    offset: usize,
    /// The text of the run the glyph under the pointer belongs to.
    shows: String,
}

fn found_at(session: &Session, document: &PagedDocument, page: usize, click: Point) -> Option<Hit> {
    let frame = &document.pages().get(page.checked_sub(1)?)?.frame;
    // A double-click lands inside a word, but not always inside a glyph's box:
    // the gap between two letters, or a point just under the baseline, is part
    // of the word to the eye and of neither glyph to the layout. A few nearby
    // points settle those without reaching across to the next word.
    [(0.0, 0.0), (-1.5, 0.0), (1.5, 0.0), (0.0, 2.0), (0.0, -2.0)]
        .iter()
        .find_map(|&(dx, dy)| glyph_at(&session.world, frame, click + Point::new(Abs::pt(dx), Abs::pt(dy))))
}

fn wrong_shape(document: &PagedDocument, page: usize, shown: &Shown) -> Option<String> {
    if document.pages().len() != shown.pages {
        return Some(format!("{} pages laid out, {} shown", document.pages().len(), shown.pages));
    }
    let laid_out = document.pages().get(page.checked_sub(1)?)?;
    let size = laid_out.frame.size();
    if (size.x.to_pt() - shown.width).abs() > 0.5 || (size.y.to_pt() - shown.height).abs() > 0.5 {
        return Some(format!(
            "page {page} is {:.1}x{:.1}pt, shown {:.1}x{:.1}pt",
            size.x.to_pt(), size.y.to_pt(), shown.width, shown.height
        ));
    }
    None
}

/// Whether what was laid out here is not what the preview draws here.
///
/// Both sides are a run of text: the one pdf.js reports under the pointer, and
/// the one the glyph found belongs to. Either may be the longer — the two split
/// their runs at different places — so it is enough that one contains the
/// other, counting characters rather than reading them in order. Order is no
/// use: Typst lays a right-to-left run out visually and pdf.js turns it back
/// into logical order, so the two read a line of Hebrew in opposite directions.
///
/// Both are brought to NFKC first, since pdf.js unpacks ligatures, and the
/// characters [`ignored`] leaves out are dropped from each. Where that leaves
/// nothing to compare — a space, a script whose text a PDF cannot return — the
/// answer stands as given.
fn disagreement(hit: &Option<Hit>, reported: &str) -> Option<String> {
    let hit = hit.as_ref()?;
    let ours = counted(&hit.shows);
    let theirs = counted(reported);
    if ours.is_empty() || theirs.is_empty() || covers(&ours, &theirs) || covers(&theirs, &ours) {
        return None;
    }
    Some(format!(
        "the preview shows {:?} where the layout has {:?}",
        reported.chars().take(40).collect::<String>(),
        hit.shows.chars().take(40).collect::<String>()
    ))
}

/// Whether every character of `part` appears in `whole` at least as often.
fn covers(whole: &HashMap<char, usize>, part: &HashMap<char, usize>) -> bool {
    part.iter().all(|(c, n)| whole.get(c).is_some_and(|m| m >= n))
}

fn counted(text: &str) -> HashMap<char, usize> {
    let mut counts = HashMap::new();
    for c in text.nfkc().filter(|c| !ignored(*c)) {
        *counts.entry(c).or_default() += 1;
    }
    counts
}

/// Lets go of the laid-out document when nobody has double-clicked for a while.
///
/// A long document's layout and the caches behind it are tens of megabytes, and
/// there is no reason to hold them through an afternoon of writing. The next
/// double-click lays it out again.
pub fn release_if_idle(after: std::time::Duration) -> bool {
    let mut session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let idle = session.as_ref().is_some_and(|s| s.used.elapsed() >= after);
    if idle {
        *session = None;
        comemo::evict(0);
    }
    idle
}

static CLICKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PREPARING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the layout should be made again ahead of the next click: it was let
/// go after a quiet spell, and this is someone who does double-click the
/// preview. Someone who never has is not made to hold a long document's layout
/// in memory for nothing.
pub fn wants_layout() -> bool {
    if !CLICKED.load(std::sync::atomic::Ordering::Relaxed) || PREPARING.load(std::sync::atomic::Ordering::Acquire) {
        return false;
    }
    // Held means a click is being answered right now, which lays it out anyway.
    // A layout that failed is left alone: the next click will say why, and trying
    // again after every compile would only repeat the failure.
    SESSION.try_lock().is_ok_and(|session| session.is_none())
}

/// Scans the fonts ahead of the first double-click, which would otherwise wait
/// a second or two on it. Call it from a background thread.
pub fn warm_fonts(root: &Path) {
    let _ = font_store(&FontConfig::for_root(root, true));
}

/// Lays the document out before anyone double-clicks, so the first click after
/// opening a project answers as quickly as the ones after it. That first layout
/// is the slow part of a jump, a second or more on a long document. A click
/// already under way has the session, and this steps aside for it.
pub fn prepare(root: &Path, main: &Path) {
    if PREPARING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            PREPARING.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    let _done = Done;
    let Ok(mut session) = SESSION.try_lock() else { return };
    let _ = layout(&mut session, root, main, false);
}

/// Characters left out of the comparison.
///
/// Whitespace and invisible marks, which pdf.js adds or drops. Unmapped glyphs,
/// which reach pdf.js as control characters, private-use code points or U+FFFD.
/// And the scripts whose shaping merges and reorders characters — Devanagari,
/// Bengali and the other Brahmic scripts, Thai, Tibetan, Myanmar, Khmer: a PDF
/// cannot give their text back as it was typed, so what pdf.js reads there says
/// nothing about whether the preview is current. Clicks on them are taken at
/// face value rather than refused.
fn ignored(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{20}' | '\u{7F}'..='\u{A0}' | '\u{AD}' | '\u{1680}' | '\u{180E}' | '\u{2000}'..='\u{200F}'
            | '\u{2028}'..='\u{202F}' | '\u{205F}'..='\u{206F}' | '\u{3000}' | '\u{FEFF}' | '\u{FFFD}'
            | '\u{E000}'..='\u{F8FF}'
            | '\u{0900}'..='\u{0DFF}' | '\u{0E00}'..='\u{0FFF}' | '\u{1000}'..='\u{109F}' | '\u{1780}'..='\u{17FF}'
            | '\u{1B00}'..='\u{1BFF}' | '\u{1CD0}'..='\u{1CFF}' | '\u{A8E0}'..='\u{A8FF}' | '\u{A980}'..='\u{AAFF}'
            | '\u{11000}'..='\u{111FF}'
    )
}

fn locate(world: &JumpWorld, id: FileId, offset: usize) -> Jump {
    let path = id.vpath().get_without_slash().to_string();
    if let VirtualRoot::Package(spec) = id.root() {
        return Jump::Package { package: spec.to_string(), path };
    }
    let Ok(source) = world.source(id) else { return Jump::Nothing };
    let lines = source.lines();
    let Some(line) = lines.byte_to_line(offset) else { return Jump::Nothing };
    let start = lines.line_to_byte(line).unwrap_or(0);
    let column = source.text().get(start..offset).map_or(0, |text| text.encode_utf16().count());
    Jump::Source { path, offset, line: line + 1, column: column + 1 }
}

/// The source position of what is drawn under `click`.
///
/// Items are visited in the order they were painted and the last one under the
/// pointer wins, since that is the one on top. Alongside, the walk keeps the
/// elements it is inside of, read from the start and end tags Typst leaves in
/// the frame, because a glyph's own span is not always the right answer:
///
/// - The words of a reference — "Equation (1)", "Table 2" — are drawn from the
///   referenced element, not from `@label`. Double-clicking one should find the
///   reference where it was written, so inside a reference or citation the
///   answer is always that.
/// - Some text is generated with no span at all: a footnote's marker, the
///   "Table 1:" before a caption. That answers with the element it belongs to.
///
/// Links are not followed, for the same reason as references.
fn glyph_at(world: &JumpWorld, frame: &Frame, click: Point) -> Option<Hit> {
    let mut open = Vec::new();
    let mut best = None;
    walk(world, frame, Some(click), &mut open, &mut best);
    best
}

struct Open {
    location: Option<Location>,
    span: Span,
    reference: bool,
}

fn walk(world: &JumpWorld, frame: &Frame, click: Option<Point>, open: &mut Vec<Open>, best: &mut Option<Hit>) {
    for (pos, item) in frame.items() {
        let pos = *pos;
        match item {
            FrameItem::Tag(Tag::Start(content, _)) => open.push(Open {
                location: content.location(),
                span: content.span(),
                // A group of citations is not itself a citation: inside one,
                // each citation still answers for its own text.
                reference: content.is::<RefElem>() || content.is::<CiteElem>(),
            }),
            FrameItem::Tag(Tag::End(location, ..)) => {
                if let Some(at) = open.iter().rposition(|o| o.location == Some(*location)) {
                    open.truncate(at);
                }
            }
            // Groups are always entered, even ones the pointer is not over, so
            // that the tags inside them keep the list of open elements right.
            FrameItem::Group(group) => {
                let inside = click.and_then(|click| {
                    let local = click - pos;
                    let clipped = group.clip.as_ref().is_some_and(|clip| !clip.contains(FillRule::NonZero, local));
                    if clipped { None } else { group.transform.invert().map(|inverse| local.transform_inf(inverse)) }
                });
                walk(world, &group.frame, inside, open, best);
            }
            FrameItem::Text(text) => {
                let Some(click) = click else { continue };
                if let Some(glyph) = glyph_under(text, pos, click)
                    && let Some((id, offset)) = answer(world, open, glyph.span)
                {
                    *best = Some(Hit { id, offset, shows: text.text.to_string() });
                }
            }
            FrameItem::Shape(shape, span) if shape.fill.is_some() => {
                let Some(click) = click else { continue };
                let within = match &shape.geometry {
                    Geometry::Rect(size) => in_rect(pos, *size, click),
                    Geometry::Curve(curve) => curve.contains(shape.fill_rule, click - pos),
                    Geometry::Line(_) => false,
                };
                if within && let Some((id, offset)) = span_start(world, *span) {
                    *best = Some(Hit { id, offset, shows: String::new() });
                }
            }
            FrameItem::Image(_, size, span) => {
                if click.is_some_and(|click| in_rect(pos, *size, click))
                    && let Some((id, offset)) = span_start(world, *span)
                {
                    *best = Some(Hit { id, offset, shows: String::new() });
                }
            }
            _ => {}
        }
    }
}

/// The span of the glyph of `text` under `click`, the last one if several.
///
/// Each glyph is placed as the renderer places it: moved by its own offsets,
/// and by the vertical advance of the glyphs before it, which is how the tall
/// brackets of a matrix are stacked out of pieces that advance not at all
/// sideways. A glyph counts as hit inside its outline's bounding box, or inside
/// the band a font size tall over its horizontal advance, which catches the
/// gaps between letters that belong to a word.
fn glyph_under(text: &TextItem, pos: Point, click: Point) -> Option<&Glyph> {
    let scale = text.size.to_pt() / text.font.units_per_em();
    let mut hit = None;
    let (mut x, mut y) = (pos.x, Abs::zero());
    for glyph in &text.glyphs {
        let width = glyph.x_advance.at(text.size);
        let band = in_rect(Point::new(x, pos.y - y - text.size), Size::new(width, text.size * 1.25), click);
        let origin = Point::new(x + glyph.x_offset.at(text.size), pos.y - y - glyph.y_offset.at(text.size));
        let outline = text.font.ttf().glyph_bounding_box(ttf_parser::GlyphId(glyph.id)).is_some_and(|b| {
            let left = origin.x + Abs::pt(f64::from(b.x_min) * scale);
            let top = origin.y - Abs::pt(f64::from(b.y_max) * scale);
            let size = Size::new(Abs::pt(f64::from(b.x_max - b.x_min) * scale), Abs::pt(f64::from(b.y_max - b.y_min) * scale));
            in_rect(Point::new(left, top), size, click)
        });
        if band || outline {
            hit = Some(glyph);
        }
        x += width;
        y += glyph.y_advance.at(text.size);
    }
    hit
}

fn answer(world: &JumpWorld, open: &[Open], (span, within): (Span, u16)) -> Option<(FileId, usize)> {
    if let Some(reference) = open.iter().rev().find(|o| o.reference) {
        return span_start(world, reference.span);
    }
    if let Some(id) = span.id() {
        let source = world.source(id).ok()?;
        let node = source.find(span)?;
        let offset = match node.kind() {
            SyntaxKind::Text | SyntaxKind::MathText => (node.range().start + usize::from(within)).min(node.range().end),
            // `"if"` in a formula: the glyphs count from inside the quote.
            SyntaxKind::Str => (node.range().start + 1 + usize::from(within)).min(node.range().end),
            _ => node.offset(),
        };
        return Some((id, offset));
    }
    open.iter().rev().find_map(|o| span_start(world, o.span))
}

fn span_start(world: &JumpWorld, span: Span) -> Option<(FileId, usize)> {
    let id = span.id()?;
    let node = world.source(id).ok()?.find(span)?.offset();
    Some((id, node))
}

fn in_rect(pos: Point, size: Size, click: Point) -> bool {
    pos.x <= click.x && click.x <= pos.x + size.x && pos.y <= click.y && click.y <= pos.y + size.y
}

// ---------------------------------------------------------------------------
// The compiled document, kept between double-clicks.
// ---------------------------------------------------------------------------

type Stamp = Option<(SystemTime, u64)>;

struct Session {
    used: Instant,
    root: PathBuf,
    main: PathBuf,
    settings: Settings,
    fonts: FontConfig,
    world: JumpWorld,
    document: Option<Arc<PagedDocument>>,
    /// Every file the last compilation read, stamped as it was read. While none
    /// has changed, the next click can reuse the document without compiling.
    read: Vec<(PathBuf, Stamp)>,
}

static SESSION: LazyLock<Mutex<Option<Session>>> = LazyLock::new(|| Mutex::new(None));

/// The laid-out document, and whether it was compiled for this request.
fn layout(
    session: &mut Option<Session>,
    root: &Path,
    main: &Path,
    fresh: bool,
) -> Result<(Arc<PagedDocument>, bool), String> {
    // Compared canonically, so a main file that is a link notices being pointed
    // somewhere else.
    let root = root.canonicalize().map_err(|e| format!("project folder: {e}"))?;
    let main = main.canonicalize().map_err(|e| format!("main file: {e}"))?;
    let settings = Settings::from_env(&root);
    let fonts = FontConfig::for_root(&root, fresh);
    let reusable = session
        .as_ref()
        .is_some_and(|s| s.root == root && s.main == main && s.settings == settings && s.fonts == fonts);
    if !reusable {
        *session = Some(Session {
            used: Instant::now(),
            world: JumpWorld::new(&root, &main, &settings, font_store(&fonts))?,
            root,
            main,
            settings,
            fonts,
            document: None,
            read: Vec::new(),
        });
    }
    let s = session.as_mut().expect("session was just filled");
    s.used = Instant::now();

    if !fresh
        && let Some(document) = &s.document
        && s.read.iter().all(|(path, stamp)| stamp_of(path) == *stamp)
    {
        return Ok((document.clone(), false));
    }

    // Files are read afresh, but sources whose text did not change keep their
    // identity, so Typst's caches make a second compilation a partial one.
    s.world.files.reset();
    s.world.now.reset();
    s.world.files.loader().read.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let result = typst::compile::<PagedDocument>(&s.world).output;
    comemo::evict(10);
    s.read = std::mem::take(&mut *s.world.files.loader().read.lock().unwrap_or_else(|e| e.into_inner()));

    match result {
        Ok(document) => {
            let document = Arc::new(document);
            s.document = Some(document.clone());
            Ok((document, true))
        }
        Err(errors) => {
            s.document = None;
            Err(errors.first().map(|e| e.message.to_string()).unwrap_or_else(|| "the document did not compile".into()))
        }
    }
}

fn stamp_of(path: &Path) -> Stamp {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

// ---------------------------------------------------------------------------
// A world that compiles exactly as `typst compile --root <root>` does when run
// from Hilbert's backend, whose working directory is the project.
// ---------------------------------------------------------------------------

/// What the CLI reads from its environment and would lay a page out by.
#[derive(Clone, PartialEq)]
struct Settings {
    features: Vec<Feature>,
    /// `SOURCE_DATE_EPOCH`, which fixes `datetime.today()`.
    timestamp: Option<i64>,
    package_path: Option<PathBuf>,
    package_cache_path: Option<PathBuf>,
}

impl Settings {
    fn from_env(root: &Path) -> Self {
        let path = |name| std::env::var_os(name).filter(|v| !v.is_empty()).map(|v| within(root, PathBuf::from(v)));
        Self {
            features: std::env::var("TYPST_FEATURES").map(|v| features(&v)).unwrap_or_default(),
            timestamp: std::env::var("SOURCE_DATE_EPOCH").ok().and_then(|v| v.trim().parse().ok()),
            package_path: path("TYPST_PACKAGE_PATH"),
            package_cache_path: path("TYPST_PACKAGE_CACHE_PATH"),
        }
    }
}

/// A path from the environment, read as the CLI reads it from the project.
fn within(root: &Path, path: PathBuf) -> PathBuf {
    if path.is_relative() { root.join(path) } else { path }
}

/// `TYPST_FEATURES`, a comma-separated list, with names the CLI does not know
/// left out rather than failing the lookup.
fn features(list: &str) -> Vec<Feature> {
    list.split(',')
        .filter_map(|name| match name.trim() {
            "html" => Some(Feature::Html),
            "bundle" => Some(Feature::Bundle),
            "a11y-extras" => Some(Feature::A11yExtras),
            _ => None,
        })
        .collect()
}

struct JumpWorld {
    library: LazyHash<Library>,
    fonts: Arc<FontStore>,
    main: FileId,
    files: FileStore<ProjectFiles>,
    now: Time,
}

impl JumpWorld {
    fn new(root: &Path, main: &Path, settings: &Settings, fonts: Arc<FontStore>) -> Result<Self, String> {
        let vpath = VirtualPath::virtualize(root, main).map_err(|_| "the main file is outside the project".to_string())?;
        let library = Library::builder().with_features(settings.features.iter().copied().collect()).build();
        let now = match settings.timestamp {
            Some(timestamp) => Time::fixed_timestamp(timestamp).map_err(|e| e.to_string())?,
            None => Time::system(),
        };
        let packages = SystemPackages::from_parts(
            settings.package_path.clone().map(FsPackages::new).or_else(FsPackages::system_data),
            settings.package_cache_path.clone().map(FsPackages::new).or_else(FsPackages::system_cache),
            // Nothing is downloaded here: a package the preview used is already
            // in the cache, and one it did not use has nothing on screen to click.
            UniversePackages::new(Offline),
        );
        Ok(Self {
            library: LazyHash::new(library),
            fonts,
            main: RootedPath::new(VirtualRoot::Project, vpath).intern(),
            files: FileStore::new(ProjectFiles { project: FsRoot::new(root.to_path_buf()), packages, read: Mutex::default() }),
            now,
        })
    }
}

impl World for JumpWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.files.source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.file(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.now.today(offset)
    }
}

struct ProjectFiles {
    project: FsRoot,
    packages: SystemPackages,
    /// Each file read during a compilation, stamped just before its bytes were
    /// read. Stamping afterwards could record an edit the compilation never saw
    /// as if it had, and keep an old layout forever.
    read: Mutex<Vec<(PathBuf, Stamp)>>,
}

impl FileLoader for ProjectFiles {
    fn load(&self, id: FileId) -> FileResult<Bytes> {
        let root = match id.root() {
            VirtualRoot::Project => self.project.clone(),
            VirtualRoot::Package(spec) => self.packages.obtain(spec)?,
        };
        if let Ok(path) = root.resolve(id.vpath()) {
            let stamp = stamp_of(&path);
            self.read.lock().unwrap_or_else(|e| e.into_inner()).push((path, stamp));
        }
        root.load(id.vpath())
    }
}

struct Offline;

impl Downloader for Offline {
    fn stream(&self, _: &dyn Any, url: &str) -> io::Result<(Option<usize>, Box<dyn Read>)> {
        Err(io::Error::new(io::ErrorKind::NotConnected, format!("not downloading {url} for a jump")))
    }
}

// ---------------------------------------------------------------------------
// Fonts, gathered once and shared, since scanning the system takes a while.
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq)]
struct FontConfig {
    paths: Vec<PathBuf>,
    /// What is in those folders, so a font added while Hilbert runs is found,
    /// as the preview's watcher finds it.
    contents: u64,
    system: bool,
    embedded: bool,
}

/// How long a reading of the font folders is taken as still true. Walking them
/// costs a directory listing per click, and a font arriving mid-session is rare
/// enough to wait a moment for; a layout that disagrees with the preview asks
/// for a fresh reading anyway.
const FONT_RESCAN: std::time::Duration = std::time::Duration::from_secs(2);

static LAST_SCAN: LazyLock<Mutex<Option<(PathBuf, Instant, FontConfig)>>> = LazyLock::new(|| Mutex::new(None));

impl FontConfig {
    /// As [`FontConfig::read`], but reusing a recent reading for the same
    /// project unless `fresh` is asked for.
    fn for_root(root: &Path, fresh: bool) -> Self {
        let mut last = LAST_SCAN.lock().unwrap_or_else(|e| e.into_inner());
        if !fresh
            && let Some((known, seen, config)) = last.as_ref()
            && known == root
            && seen.elapsed() < FONT_RESCAN
        {
            return config.clone();
        }
        let config = Self::read(root);
        *last = Some((root.to_path_buf(), Instant::now(), config.clone()));
        config
    }

    /// What the CLI ends up with for Hilbert's arguments: a `fonts` folder in
    /// the project is passed as `--font-path`, which replaces anything set in
    /// `TYPST_FONT_PATHS`.
    fn read(root: &Path) -> Self {
        let local = root.join("fonts");
        let paths: Vec<PathBuf> = if local.is_dir() {
            vec![local]
        } else {
            std::env::var_os("TYPST_FONT_PATHS")
                .map(|v| std::env::split_paths(&v).filter(|p| !p.as_os_str().is_empty()).map(|p| within(root, p)).collect())
                .unwrap_or_default()
        };
        let contents = paths.iter().fold(0u64, |acc, p| acc.rotate_left(7) ^ crate::server::font_signature(p));
        Self { paths, contents, system: !env_flag("TYPST_IGNORE_SYSTEM_FONTS"), embedded: !env_flag("TYPST_IGNORE_EMBEDDED_FONTS") }
    }
}

/// Read as clap reads a boolean flag from the environment.
fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "0" | "false" | "no" | "off" | "n" | "f"))
        .unwrap_or(false)
}

type CachedFonts = Option<(FontConfig, Arc<FontStore>)>;

static FONTS: LazyLock<Mutex<CachedFonts>> = LazyLock::new(|| Mutex::new(None));

fn font_store(config: &FontConfig) -> Arc<FontStore> {
    let mut cached = FONTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((known, store)) = cached.as_ref()
        && known == config
    {
        return store.clone();
    }
    // In the CLI's order, which decides which of two same-named fonts wins.
    let mut store = FontStore::new();
    if config.system {
        store.extend(fonts::system());
    }
    if config.embedded {
        store.extend(fonts::embedded());
    }
    for path in &config.paths {
        store.extend(fonts::scan(path));
    }
    let store = Arc::new(store);
    *cached = Some((config.clone(), store.clone()));
    store
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(files: &[(&str, &str)]) -> PathBuf {
        // Tests run side by side and the clock is not fine enough to tell two of
        // them apart, so a counter keeps each project in a folder of its own.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hilbert-jump-{}-{n}", std::process::id()));
        for (path, text) in files {
            let full = dir.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        dir
    }

    /// Every glyph on the page with the text it draws and a point at its middle,
    /// gathered by a walk of the test's own rather than by `glyph_at`.
    fn glyphs(frame: &Frame, origin: Point, out: &mut Vec<(Point, String)>) {
        for (pos, item) in frame.items() {
            let at = origin + *pos;
            match item {
                FrameItem::Group(group) => glyphs(&group.frame, at, out),
                FrameItem::Text(text) => {
                    let mut x = at.x;
                    for glyph in &text.glyphs {
                        let width = glyph.x_advance.at(text.size);
                        out.push((Point::new(x + width / 2.0, at.y - text.size * 0.35), text.text[glyph.range()].to_string()));
                        x += width;
                    }
                }
                _ => {}
            }
        }
    }

    #[test]
    fn every_glyph_leads_back_to_the_file_and_byte_it_was_written_at() {
        // The same words in both files, so being right is a matter of position,
        // not spelling. `fi` is a ligature in the default font, one glyph for
        // two letters, which a letter-per-glyph test would trip over.
        let chapter = "The field of the field is a field.\n";
        let main = "#set page(width: 12cm, height: auto, margin: 1cm)\n\nThe field of the field is a field.\n\n#include \"chapter.typ\"\n";
        let dir = project(&[("main.typ", main), ("chapter.typ", chapter)]);
        let session = &mut None;
        let document = layout(session, &dir, &dir.join("main.typ"), false).map(|(d, _)| d).expect("fixture compiles");
        let world = &session.as_ref().unwrap().world;

        let mut drawn = Vec::new();
        glyphs(&document.pages()[0].frame, Point::zero(), &mut drawn);

        // The answer each glyph should give, found without spans: the next place
        // its text occurs, reading main.typ's paragraph and then the chapter.
        let streams = [("main.typ", main, main.find("The field").unwrap()), ("chapter.typ", chapter, 0)];
        let (mut stream, mut cursor) = (0, streams[0].2);
        let mut checked = 0;
        for (point, text) in drawn.iter().filter(|(_, t)| t.chars().all(char::is_alphabetic) && !t.is_empty()) {
            let body = streams[stream].1;
            let found = match body[cursor..].find(text.as_str()) {
                // A paragraph ends at its full stop; past it, read the next file.
                Some(at) if !body[cursor..cursor + at].contains('.') => cursor + at,
                _ => {
                    stream += 1;
                    let (_, next, start) = streams[stream];
                    start + next[start..].find(text.as_str()).unwrap()
                }
            };
            let file = streams[stream].0;
            let hit = glyph_at(world, &document.pages()[0].frame, *point).unwrap_or_else(|| panic!("no glyph under {text:?}"));
            assert_eq!((hit.id.vpath().get_without_slash(), hit.offset), (file, found), "the glyph {text:?}");
            cursor = found + text.len();
            checked += 1;
        }
        assert!(checked >= 40, "only {checked} glyphs were checked");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn text_typst_generates_answers_with_what_generated_it() {
        let main = "#set page(width: 14cm, height: 12cm, margin: 1.5cm)\n#set math.equation(numbering: \"(1)\")\n#set heading(numbering: \"1.1\")\n= Heading words\nSome text.#footnote[Footnote words.]\n$ phi = 0 $ <e>\nSee @e and @t.\n#figure(table(columns: 2, [alpha], [beta]), caption: [Caption words], supplement: [Grid]) <t>\n";
        let dir = project(&[("main.typ", main)]);
        let session = &mut None;
        let document = layout(session, &dir, &dir.join("main.typ"), false).map(|(d, _)| d).expect("compiles");
        let world = &session.as_ref().unwrap().world;
        let page = &document.pages()[0].frame;
        let mut drawn = Vec::new();
        glyphs(page, Point::zero(), &mut drawn);
        let under = |text: &str, nth: usize| {
            let (point, _) = drawn.iter().filter(|(_, t)| t == text).nth(nth).unwrap_or_else(|| panic!("no {nth}th {text:?} drawn"));
            glyph_at(world, page, *point).map(|hit| hit.offset)
        };
        let at = |needle: &str| main.find(needle).unwrap();

        // "See Equation (1)": the word comes from the equation's supplement.
        assert_eq!(under("E", 0), Some(at("@e")), "a reference to an equation");
        // "Grid 1": this supplement was written by hand, so its letters carry
        // spans into the figure's arguments. It is still the reference that was
        // clicked, and that is where the answer should be.
        assert_eq!(under("G", 0), Some(at("@t")), "a reference whose words have a span elsewhere");
        // The marker in the text and the one in front of the note.
        assert_eq!(under("1", 1), Some(at("#footnote") + 1), "a footnote marker");
        // The heading's number, and a word in the heading itself.
        assert_eq!(under("H", 0), Some(at("Heading")), "a word in a heading");
        // Ordinary text still answers with itself, even beside all of that.
        assert_eq!(under("C", 0), Some(at("Caption")), "a word in a caption");
        // The first `p` on the page is the one in `alpha`.
        assert_eq!(under("p", 0).map(|o| &main[o..o + 3]), Some("pha"), "a table cell");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn maths_leads_to_the_symbol_that_made_each_glyph() {
        let main = "#set page(width: 14cm, height: auto, margin: 1cm)\n$ mat(p, q; r, s) vec(u, v) $\n$ gamma^mu psi $\n$ f(x) = cases(x^2 \"if\" x > 0\\, -x \"otherwise\") $\n";
        let dir = project(&[("main.typ", main)]);
        let session = &mut None;
        let document = layout(session, &dir, &dir.join("main.typ"), false).map(|(d, _)| d).unwrap();
        let world = &session.as_ref().unwrap().world;
        let page = &document.pages()[0].frame;
        let mut drawn = Vec::new();
        glyphs(page, Point::zero(), &mut drawn);
        let under = |text: &str, nth: usize| {
            let (point, _) = drawn.iter().filter(|(_, t)| t == text).nth(nth).unwrap_or_else(|| panic!("no {nth}th {text:?}"));
            glyph_at(world, page, *point).map(|hit| hit.offset)
        };
        let at = |needle: &str| main.find(needle).unwrap();
        // Matrix and vector cells, which look nothing like their source.
        assert_eq!(under("𝑞", 0), Some(at("q;")), "a matrix cell");
        assert_eq!(under("𝑣", 0), Some(at("v)")), "a vector cell");
        // A named symbol, and a letter that is only itself.
        assert_eq!(under("𝛾", 0), Some(at("gamma")), "a Greek symbol");
        assert_eq!(under("𝜓", 0), Some(at("psi ")), "another one");
        // Quoted words inside a formula, letter by letter rather than landing
        // on the opening quote.
        assert_eq!(under("o", 0), Some(at("otherwise")), "a word in quotes");
        assert_eq!(under("h", 0), Some(at("otherwise") + 2), "and its third letter");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_click_reports_line_and_column_the_way_the_editor_counts_them() {
        // Non-ASCII before the word, so bytes, chars and UTF-16 units all differ.
        let main = "#set page(width: 12cm, height: auto, margin: 1cm)\n\nÅngström 𝔘 idea here\n";
        let dir = project(&[("main.typ", main)]);
        let session = &mut None;
        layout(session, &dir, &dir.join("main.typ"), false).map(|(d, _)| d).unwrap();
        let world = &session.as_ref().unwrap().world;
        let id = world.main();
        let offset = main.find("idea").unwrap();
        assert_eq!(
            locate(world, id, offset),
            Jump::Source { path: "main.typ".into(), offset, line: 3, column: "Ångström 𝔘 ".encode_utf16().count() + 1 }
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unchanged_project_is_not_compiled_twice_and_an_edit_is_noticed() {
        let dir = project(&[("main.typ", "#set page(width: 10cm, height: auto)\nfirst\n")]);
        let session = &mut None;
        let a = layout(session, &dir, &dir.join("main.typ"), false).map(|(d, _)| d).unwrap();
        let b = layout(session, &dir, &dir.join("main.typ"), false).map(|(d, _)| d).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "nothing changed, so the same document");
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("main.typ"), "#set page(width: 10cm, height: auto)\nsecond, and longer\n").unwrap();
        let c = layout(session, &dir, &dir.join("main.typ"), false).map(|(d, _)| d).unwrap();
        assert!(!Arc::ptr_eq(&a, &c), "an edited file means a fresh layout");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pages_that_differ_from_the_preview_are_refused() {
        let dir = project(&[("main.typ", "#set page(width: 10cm, height: 8cm)\nsome words\n")]);
        let main = dir.join("main.typ");
        let wrong = Shown { pages: 1, width: 595.0, height: 842.0, expect: None };
        assert!(matches!(jump(&dir, &main, 1, 40.0, 40.0, Some(wrong)), Jump::LayoutDiffers(_)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_is_checked_against_what_the_preview_draws_there() {
        let hit = |shows: &str| Some(Hit { id: FileId::unique(RootedPath::new(VirtualRoot::Project, VirtualPath::new("main.typ").unwrap())), offset: 0, shows: shows.into() });
        assert_eq!(disagreement(&hit("the field"), "the field"), None, "the same run");
        assert_eq!(disagreement(&hit("field"), "the field of"), None, "pdf.js joined more into its run");
        assert_eq!(disagreement(&hit("the field of"), "field"), None, "or split it further");
        assert_eq!(disagreement(&hit("ﬁeld"), "field"), None, "a ligature unpacked");
        assert_eq!(disagreement(&hit("שלום עולם"), "םלוע םולש"), None, "read the other way round");
        assert_eq!(disagreement(&hit("a\u{301}b"), "áb"), None, "an accent, composed or not");
        assert_eq!(disagreement(&hit(" "), "anything"), None, "a space says nothing");
        assert_eq!(disagreement(&hit("সোনার"), "\u{3}আ\u{6}"), None, "a script a PDF cannot return");
        // The paragraph that was here has been swapped for another.
        assert!(disagreement(&hit("car"), "cat").is_some(), "one letter apart");
        assert!(disagreement(&hit("the second line"), "the first line").is_some(), "a line that moved");
    }

    #[test]
    fn a_stale_cached_layout_is_caught_by_the_glyph_even_with_the_old_file_time() {
        let text = |word: &str| format!("#set page(width: 10cm, height: 6cm, margin: 1cm)\nA {word} here.\n");
        let dir = project(&[("main.typ", &text("carrot"))]);
        let main = dir.join("main.typ");
        let then = std::fs::metadata(&main).unwrap().modified().unwrap();

        // Fill the cache with "carrot".
        assert!(matches!(jump(&dir, &main, 1, 0.0, 0.0, None), Jump::Nothing));

        // Same length, same modification time: nothing a stamp can see.
        std::fs::write(&main, text("turnip")).unwrap();
        std::fs::File::options().write(true).open(&main).unwrap().set_modified(then).unwrap();

        // The preview now shows "turnip"; find where its "u" is drawn.
        let side = &mut None;
        let shown_doc = layout(side, &dir, &main, false).unwrap().0;
        let size = shown_doc.pages()[0].frame.size();
        let mut drawn = Vec::new();
        glyphs(&shown_doc.pages()[0].frame, Point::zero(), &mut drawn);
        let (point, _) = drawn.iter().find(|(_, t)| t == "u").unwrap();
        let shown = Shown { pages: 1, width: size.x.to_pt(), height: size.y.to_pt(), expect: Some("A turnip here.".into()) };

        match jump(&dir, &main, 1, point.x.to_pt(), point.y.to_pt(), Some(shown)) {
            Jump::Source { offset, .. } => assert_eq!(&text("turnip")[offset..offset + 5], "urnip"),
            other => panic!("expected the fresh layout to be used, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_preview_showing_something_else_is_refused_rather_than_read() {
        let main = "#set page(width: 10cm, height: 6cm, margin: 1cm)\nA carrot here.\n";
        let dir = project(&[("main.typ", main)]);
        let path = dir.join("main.typ");
        let session = &mut None;
        let document = layout(session, &dir, &path, false).unwrap().0;
        let size = document.pages()[0].frame.size();
        let mut drawn = Vec::new();
        glyphs(&document.pages()[0].frame, Point::zero(), &mut drawn);
        let (point, _) = drawn.iter().find(|(_, t)| t == "c").unwrap();
        // The preview claims a "z" there: whatever is on screen, it is not this.
        let shown = Shown { pages: 1, width: size.x.to_pt(), height: size.y.to_pt(), expect: Some("A zucchini here.".into()) };
        assert!(matches!(jump(&dir, &path, 1, point.x.to_pt(), point.y.to_pt(), Some(shown)), Jump::LayoutDiffers(_)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unused_layout_is_let_go_of() {
        let dir = project(&[("main.typ", "#set page(width: 8cm, height: auto)\nwords\n")]);
        let main = dir.join("main.typ");
        assert!(matches!(jump(&dir, &main, 1, 0.0, 0.0, None), Jump::Nothing));
        assert!(SESSION.lock().unwrap().is_some(), "a layout is kept for the next click");
        assert!(!release_if_idle(std::time::Duration::from_secs(60)), "not while it is fresh");
        assert!(release_if_idle(std::time::Duration::ZERO), "and let go of once it is not");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn features_and_relative_paths_are_read_as_the_cli_reads_them() {
        assert_eq!(features("html, a11y-extras,unknown"), vec![Feature::Html, Feature::A11yExtras]);
        assert_eq!(within(Path::new("/p"), PathBuf::from("fonts")), PathBuf::from("/p/fonts"));
        assert_eq!(within(Path::new("/p"), PathBuf::from("/abs")), PathBuf::from("/abs"));
    }

    #[test]
    fn the_middle_of_a_tall_bracket_built_from_pieces_can_be_clicked() {
        let main = "#set page(width: 12cm, height: auto, margin: 1cm)\n$ lr((mat(1; 2; 3; 4; 5; 6; 7; 8))) $\n";
        let dir = project(&[("main.typ", main)]);
        let session = &mut None;
        let document = layout(session, &dir, &dir.join("main.typ"), false).map(|(d, _)| d).unwrap();
        let world = &session.as_ref().unwrap().world;
        let page = &document.pages()[0].frame;
        // Pieces of an assembled delimiter do not advance sideways.
        let mut pieces = Vec::new();
        stacked_pieces(page, Point::zero(), &mut pieces);
        assert!(pieces.len() >= 3, "expected the bracket to be assembled from pieces, found {}", pieces.len());
        for centre in &pieces {
            let hit = glyph_at(world, page, *centre).expect("a piece of the bracket");
            assert!(main[..hit.offset].contains("$ "), "lands in the equation, not before it");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Centres of glyph outlines that advance vertically, placed the way
    /// typst-render places them.
    fn stacked_pieces(frame: &Frame, origin: Point, out: &mut Vec<Point>) {
        for (pos, item) in frame.items() {
            let at = origin + *pos;
            match item {
                FrameItem::Group(group) => stacked_pieces(&group.frame, at, out),
                FrameItem::Text(text) => {
                    let scale = text.size.to_pt() / text.font.units_per_em();
                    let (mut x, mut y) = (at.x, Abs::zero());
                    for glyph in &text.glyphs {
                        if glyph.y_advance.get() != 0.0
                            && let Some(b) = text.font.ttf().glyph_bounding_box(ttf_parser::GlyphId(glyph.id))
                        {
                            let ox = x + glyph.x_offset.at(text.size);
                            let oy = at.y - y - glyph.y_offset.at(text.size);
                            out.push(Point::new(
                                ox + Abs::pt(f64::from(b.x_min + b.x_max) / 2.0 * scale),
                                oy - Abs::pt(f64::from(b.y_min + b.y_max) / 2.0 * scale),
                            ));
                        }
                        x += glyph.x_advance.at(text.size);
                        y += glyph.y_advance.at(text.size);
                    }
                }
                _ => {}
            }
        }
    }
}
