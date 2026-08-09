#import "lapreprint.typ": template

// LaPreprint: a preprint layout with a wide margin for notes, an Open Access
// badge, ORCID links and a running footer. Every option below is optional —
// delete the ones you don't want and they fall back to sensible defaults.

#show: template.with(
  title: "Your Paper Title",
  subtitle: none,
  // Shown in the running header on pages after the first.
  short-title: "Short title",

  authors: (
    (
      name: "Your Name",
      // orcid: "0000-0000-0000-0000",
      // Matches the ids in `affiliations` below; several are written "1,2".
      affiliations: "1",
      // email: "you@example.org",
    ),
    (name: "A Coauthor", affiliations: "2"),
  ),
  affiliations: (
    (id: "1", name: "Your Department, Your University"),
    (id: "2", name: "Another Institution"),
  ),

  // One paragraph on what the paper does and what it finds. For a second
  // abstract — a plain-language summary, say — pass a list of blocks instead:
  //   abstract: (
  //     (title: "Abstract", content: [...]),
  //     (title: "Plain language summary", content: [...]),
  //   ),
  abstract: [
    One paragraph saying what the paper does and what it finds.
  ],
  keywords: ("first keyword", "second keyword"),

  // The colour used for the title, headings and links.
  theme: rgb("#20496b"),

  // Everything below shows up in the margin or the footer.
  kind: "Original Research",
  venue: [Preprint],
  // doi: "10.5281/zenodo.1234567",
  margin: (
    (title: "Correspondence", content: [you\@example.org]),
  ),
  date: datetime.today(),

  // A sans face suits this layout, but Typst warns about families that aren't
  // installed, so nothing is named by default. Uncomment if you have one:
  // font-face: ("Noto Sans", "Helvetica Neue", "Arial"),

  paper-size: "a4",
  bibliography-file: "refs.bib",
)

= Introduction

Set out the problem and why it matters. Cite as you go @source, and cross-refer
to results by label, like @mass-energy.

= Methods

Equations are numbered automatically:

$ E = m c^2 $ <mass-energy>

Display maths, figures and tables all behave as they do anywhere else in Typst:

#figure(
  rect(width: 60%, height: 3cm, stroke: 0.5pt + gray),
  caption: [Replace this box with `image("figure.png", width: 60%)`.],
) <first-figure>

= Results

Refer back to @first-figure. Sub-sections number as 1.a, 1.b, and so on.

== A sub-section

Text.

= Discussion

What it means, and what it doesn't.

= Acknowledgment

This heading is deliberately left unnumbered by the template.
