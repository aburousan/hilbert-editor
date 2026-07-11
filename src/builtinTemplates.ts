// Starter templates that ship inside the app. Unlike "New from Template",
// which pulls a package from Typst Universe over the network, these are baked
// into the bundle and write straight into the open folder, so they work
// offline. The one exception is the Touying slides deck, whose theme package
// downloads once on first compile and is then cached forever.

interface BuiltinFile {
  // Path relative to the workspace root. The first file is the entrypoint.
  path: string;
  content: string;
  // Auxiliary files (e.g. refs.bib) that shouldn't clobber an existing one.
  keepExisting?: boolean;
}

export interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  entry: string;
  files: BuiltinFile[];
  // True when the first compile pulls a package from Universe (needs a network
  // connection once, then works offline). Shown as a small hint in the UI.
  downloadsOnce?: boolean;
}

const SLIDES = `#import "@preview/touying:0.6.1": *
#import themes.university: *
#import "@preview/subpar:0.2.2"
#import "@preview/fletcher:0.5.8" as fletcher: node, edge

// Talk slides, powered by Touying (the Typst counterpart to Beamer).
// Swap \`themes.university\` for themes.metropolis, themes.dewdrop, etc. to
// change the look. Each \`=\` starts a new section, each \`==\` a new slide.
// The subpar and fletcher imports above power the subfigure and diagram
// slides further down; delete them (and those slides) if you don't need them.

#show: university-theme.with(
  aspect-ratio: "16-9",
  config-info(
    title: [Your Talk Title],
    subtitle: [A short subtitle],
    author: [Your Name],
    date: datetime.today(),
    institution: [Your Institution],
  ),
)

#title-slide()

== Outline
#outline(title: none, indent: 1em, depth: 1)

= Motivation

== The Question
- What problem are we solving?
- Why does it matter?

#pause

- Reveal points one at a time with \`#pause\`.

== Some Math
The result we care about:
$ E = m c^2 $

= Results

== A Figure
#figure(
  rect(width: 60%, height: 3cm, fill: luma(240))[#align(center + horizon)[your plot here]],
  caption: [Replace this box with an image or a cetz plot.],
)

== Key Points
+ First takeaway
+ Second takeaway
+ Third takeaway

== A Floating Callout
Regular slide text goes here.

// A free-floating text box, PowerPoint style. Move it by changing dx/dy
// (0% = top-left of the slide, 100% = bottom-right).
#place(top + left, dx: 55%, dy: 30%, block(
  fill: yellow.lighten(60%), inset: 8pt, radius: 4pt, stroke: 0.5pt,
)[
  Floating callout \\
  placed anywhere
])

== Subfigures
// subpar numbers the panels (a), (b) on its own. Add a label after a panel,
// e.g. \`figure(...), <my-panel>\`, only if you want to cross-reference it —
// and keep such labels unique across the whole document.
#subpar.grid(
  figure(rect(width: 100%, height: 3cm, fill: luma(230)), caption: [left]),
  figure(rect(width: 100%, height: 3cm, fill: luma(200)), caption: [right]),
  columns: (1fr, 1fr),
  caption: [Two panels side by side.],
)

== A Flow Diagram
#align(center, fletcher.diagram(
  node-stroke: 0.5pt,
  node((0, 0), [Input]), edge("->"),
  node((1, 0), [Process]), edge("->"),
  node((2, 0), [Output]),
))

#focus-slide[
  Thank you!
  #v(0.5em)
  #text(size: 0.6em)[questions?]
]
`;

const ARTICLE = `// Plain article. No external packages, so it compiles offline immediately.

#set page(paper: "a4", margin: 2.5cm, numbering: "1")
#set par(justify: true, leading: 0.65em)
#set text(font: "New Computer Modern", size: 11pt, lang: "en")
#set heading(numbering: "1.1")

#align(center)[
  #text(size: 17pt, weight: "bold")[Article Title]
  #v(0.4em)
  Your Name \\
  #text(size: 9pt)[your.email\\@example.com]
  #v(0.2em)
  #datetime.today().display("[month repr:long] [day], [year]")
]

#v(1em)

#align(center)[
  #block(width: 85%)[
    #set text(size: 10pt)
    *Abstract.* Summarise the work in a few sentences: the question, what you
    did, and the main result.
  ]
]

#v(1em)

= Introduction
State the problem and why it matters. Cite work like this @source.

= Method
Describe the approach. Inline math such as $sum_(i=1)^n i = n(n+1)/2$ and a
displayed equation:
$ integral_0^1 x^2 dif x = 1/3 $

= Results
Present the findings. Reference figures such as @fig-one.

#figure(
  rect(width: 6cm, height: 3cm, fill: luma(240)),
  caption: [A placeholder figure.],
) <fig-one>

= Conclusion
Wrap up and point to future work.

#bibliography("refs.bib")
`;

const TWOCOL = `// Two-column paper, journal style (think PRL/REVTeX). Built-in Typst only,
// compiles offline. The title block floats across both columns via
// place(scope: "parent"); everything after it flows in two columns.

#set page(paper: "a4", margin: (x: 1.8cm, y: 2.2cm), numbering: "1", columns: 2)
#set columns(gutter: 1.6em)
#set text(font: "New Computer Modern", size: 10pt, lang: "en")
#set par(justify: true, leading: 0.58em)
#set heading(numbering: "I.A.1.")
#show heading.where(level: 1): set align(center)

// --- Title block, spanning both columns ---
#place(top + center, scope: "parent", float: true, clearance: 1.6em)[
  #text(size: 15.5pt, weight: "bold")[Paper Title: Concise and Informative]
  #v(0.6em)
  Your Name#super[1] and Co-Author Name#super[2]
  #v(0.2em)
  #text(size: 8.5pt)[
    #super[1]Department, Institution, City \\
    #super[2]Another Institution, City
  ]
  #v(0.2em)
  #text(size: 8.5pt, style: "italic")[#datetime.today().display("[month repr:long] [day], [year]")]
  #v(0.8em)
  #block(width: 88%)[
    #set text(size: 9pt)
    #set par(justify: true)
    *Abstract* — Summarise the question, the approach, and the headline result
    in one tight paragraph. Two-column readers decide from the abstract alone,
    so make every sentence carry weight.
  ]
]

= Introduction
State the problem and why it matters. Cite prior work like this @source.
Inline math flows with the text, e.g. the dispersion relation
$omega^2 = c^2 k^2$. A good introduction answers three questions in order:
what is the gap, why does closing it matter, and what does this paper do
about it. Keep the paragraphs short — in a two-column layout a long
paragraph turns into a grey wall.

The text fills the left column top to bottom first, then continues in the
right column, exactly like a REVTeX paper. Delete these placeholder
paragraphs as you write; they are here so the freshly created document
already shows the two-column flow.

= Method
Displayed equations are numbered per the document settings:
$ L = 4 pi R^2 sigma T_"eff"^4 $
Long derivations can be broken across lines with aligned equations:
$ integral_0^oo (x^3)/(e^x - 1) dif x &= Gamma(4) zeta(4) \\
  &= pi^4 / 15 $
Refer back to earlier expressions in the text rather than repeating them;
the numbering keeps everything findable.

= Results
Figures sit inside a column at full column width:

#figure(
  rect(width: 100%, height: 3.2cm, fill: luma(240))[#align(center + horizon)[your plot here]],
  caption: [A placeholder figure. Column-width by default; give a wide
  figure "placement: auto" to float it across both columns.],
) <fig-main>

As @fig-main shows, reference figures and equations the usual way.
Small tables also fit within a column:

#figure(
  table(
    columns: 3,
    align: (left, center, center),
    [Model], [$chi^2\\/"dof"$], [AIC],
    [Baseline], [1.42], [312.5],
    [Extended], [1.08], [268.1],
  ),
  caption: [A compact results table.],
) <tab-fits>

The extended model in @tab-fits is preferred by every criterion listed.

= Discussion
Interpret the findings, note the limitations, and connect back to the
question raised in the introduction. Discussion sections in short papers
work best when each paragraph makes exactly one point and the final
paragraph states plainly what the reader should take away.

= Conclusion
One paragraph: what was shown, and what follows from it.

#heading(numbering: none, level: 1)[Acknowledgments]
Thank the people and funding agencies that made the work possible.

#bibliography("refs.bib")
`;

const REPORT = `// Report / thesis skeleton in a single file. Built-in Typst only, no packages.

#set page(paper: "a4", margin: (x: 3cm, y: 3cm), numbering: "1")
#set text(font: "New Computer Modern", size: 11pt, lang: "en")
#set par(justify: true)
#set heading(numbering: "1.1")

// --- Title page ---
#page(numbering: none)[
  #align(center + horizon)[
    #text(size: 24pt, weight: "bold")[Report Title]
    #v(1em)
    #text(size: 14pt)[A Descriptive Subtitle]
    #v(3em)
    Your Name
    #v(0.5em)
    Your Institution
    #v(2em)
    #datetime.today().display("[month repr:long] [year]")
  ]
]

// --- Front matter ---
#outline(title: [Contents], indent: auto)
#pagebreak()

= Introduction
Set the scene, state the aims, outline the structure.

= Background
Review the relevant context and prior work @source.

= Approach
Explain what you did.
$ nabla dot bold(E) = rho / epsilon_0 $

= Results and Discussion
Present and interpret the findings.

= Conclusion
Summarise contributions and future directions.

#bibliography("refs.bib")
`;

const LETTER = `// Simple formal letter. Built-in Typst only, compiles offline.

#set page(paper: "a4", margin: 2.5cm)
#set text(font: "New Computer Modern", size: 11pt, lang: "en")
#set par(justify: true, leading: 0.6em)

// Sender
#align(right)[
  Your Name \\
  Street Address \\
  City, Postcode \\
  your.email\\@example.com
]

#v(1em)

// Recipient
Recipient Name \\
Organisation \\
Address Line \\
City, Postcode

#v(0.5em)
#datetime.today().display("[month repr:long] [day], [year]")
#v(1em)

Dear Recipient,

#v(0.5em)

Open with the reason for writing. Keep the body focused: one idea per
paragraph, and a clear request or conclusion at the end.

Close by stating what you would like to happen next and thank the reader
for their time.

#v(1em)
Yours sincerely,
#v(2em)
Your Name
`;

const REFS = `@article{source,
  title = {An Example Reference},
  author = {Curie, Marie},
  journal = {Journal of Examples},
  year = {2020},
  volume = {12},
  pages = {34--56},
}
`;

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'slides',
    name: 'Talk slides (Touying)',
    description: 'Presentation deck like LaTeX Beamer: title slide, sections, incremental reveals, focus slide.',
    entry: 'slides.typ',
    downloadsOnce: true,
    files: [{ path: 'slides.typ', content: SLIDES }],
  },
  {
    id: 'article',
    name: 'Article',
    description: 'Clean single-column paper with abstract, sections, math, a figure and a bibliography.',
    entry: 'article.typ',
    files: [
      { path: 'article.typ', content: ARTICLE },
      { path: 'refs.bib', content: REFS, keepExisting: true },
    ],
  },
  {
    id: 'twocol',
    name: 'Two-column paper',
    description: 'Journal-style layout (PRL/REVTeX feel): full-width title and abstract over a two-column body.',
    entry: 'paper.typ',
    files: [
      { path: 'paper.typ', content: TWOCOL },
      { path: 'refs.bib', content: REFS, keepExisting: true },
    ],
  },
  {
    id: 'report',
    name: 'Report / thesis',
    description: 'Longer document with a title page, table of contents, numbered chapters and references.',
    entry: 'report.typ',
    files: [
      { path: 'report.typ', content: REPORT },
      { path: 'refs.bib', content: REFS, keepExisting: true },
    ],
  },
  {
    id: 'letter',
    name: 'Formal letter',
    description: 'Sender and recipient blocks, dated, with a body and signature. Zero dependencies.',
    entry: 'letter.typ',
    files: [{ path: 'letter.typ', content: LETTER }],
  },
];
