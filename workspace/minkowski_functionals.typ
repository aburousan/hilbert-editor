// ================================================================
//  Minkowski Functionals — A First-Principles Guide
//  From "what is shape?" to non-Gaussianity in cosmology
//
//  Author : Kazi Abu Rousan
//  Compile: typst compile minkowski_functionals.typ
// moye moye
//================================================================

#import "@preview/cetz:0.3.4": canvas, draw

// ── Colour palette ──────────────────────────────────────────────
#let navy    = rgb("#1F4E79")
#let int-bg  = rgb("#FBF3E0")
#let int-fr  = rgb("#C8932A")
#let def-bg  = rgb("#EAF1F8")
#let def-fr  = rgb("#1F4E79")
#let phy-bg  = rgb("#EBF5EE")
#let phy-fr  = rgb("#2E7D4F")
#let acc     = rgb("#8A1538")
#let drv-bg  = rgb("#F3F1F7")
#let drv-fr  = rgb("#5E4B8B")
#let lgray   = rgb("#F2F2F2")
#let mgray   = rgb("#CCCCCC")
#let col1    = rgb("#1F4E79")   // navy
#let col2    = rgb("#C8932A")   // orange
#let col3    = rgb("#8A1538")   // crimson
#let col4    = rgb("#2E7D4F")   // green
#let col5    = rgb("#5E4B8B")   // purple

// ── Styled boxes ────────────────────────────────────────────────
// All main boxes: dashed border, pale blue fill, inline bold title
#let styled-box(title, fr, bg, body) = {
  v(0.4em, weak: true)
  block(
    width: 100%,
    fill: rgb("#EAF3FB"),
    stroke: (dash: "dashed", paint: rgb("#7A9CC0"), thickness: 0.55pt),
    inset: (x: 11pt, y: 10pt),
    radius: 2pt,
    below: 0.9em
  )[
    #set par(justify: true)
    *#title.* #body
  ]
  v(0.2em, weak: true)
}
// Example boxes: dashed border, pale grey fill
#let ibox(title: "Intuition", b)                      = styled-box(title, none, none, b)
#let dbox(title: "Definition", b)                     = styled-box(title, none, none, b)
#let pbox(title: "Why a cosmologist cares", b)        = styled-box(title, none, none, b)
#let derbox(title: "Derivation", b)                   = styled-box(title, none, none, b)
#let thmbox(title: "Theorem", b)                      = styled-box(title, none, none, b)
#let exbox(title: "Worked Example", b) = {
  v(0.4em, weak: true)
  block(
    width: 100%,
    fill: rgb("#F4F4F4"),
    stroke: (dash: "dashed", paint: rgb("#999999"), thickness: 0.55pt),
    inset: (x: 11pt, y: 10pt),
    radius: 2pt,
    below: 0.9em
  )[
    #set par(justify: true)
    *#title.* #b
  ]
  v(0.2em, weak: true)
}

// ── Numerical helpers (erf / erfc via Abramowitz & Stegun) ───────
// 7.1.26 — max |error| < 1.5 × 10⁻⁷
#let _erf-core(x) = {
  let t = 1.0 / (1.0 + 0.3275911 * x)
  let p = t * (0.254829592 + t * (-0.284496736
            + t * (1.421413741 + t * (-1.453152027
            + t * 1.061405429))))
  1.0 - p * calc.exp(-x * x)
}
#let erf(x)  = if x >= 0.0 { _erf-core(x) }  else { -_erf-core(-x) }
#let erfc(x) = 1.0 - erf(x)

// Gaussian and Hermite × Gaussian shapes (ν in units of σ₀)
#let G(x)   = calc.exp(-x * x / 2.0)
#let v0f(x) = 0.5 * erfc(x / calc.sqrt(2.0))      // ½ erfc(ν/√2)
#let v1f(x) = G(x)                                  // H₀ · G = e^{-ν²/2}
#let v2f(x) = x * G(x)                              // H₁ · G = ν e^{-ν²/2}
#let v3f(x) = (x * x - 1.0) * G(x)                 // H₂ · G = (ν²−1) e^{-ν²/2}

// ── Page layout ──────────────────────────────────────────────────
#set document(title: "Minkowski Functionals", author: "Kazi Abu Rousan")
#set page(
  paper: "a4",
  margin: (x: 2.5cm, y: 2.8cm),
  numbering: "1",
  header: context {
    if counter(page).get().first() > 1 {
      set text(size: 9pt, fill: gray)
      grid(columns: (1fr, 1fr),
        [Minkowski Functionals],
        align(right)[Kazi Abu Rousan])
      line(length: 100%, stroke: 0.3pt + gray)
    }
  }
)
#set text(font: "New Computer Modern", size: 11pt, lang: "en")
#set par(justify: true, leading: 0.65em)
#set math.equation(numbering: "(1)")
#set heading(numbering: "1.")

#show heading.where(level: 1): it => {
  v(1.4em, weak: true)
  block[
    #text(fill: navy, weight: "bold", size: 13pt)[#it]
    #v(0.15em)
    #line(length: 100%, stroke: 0.4pt + navy)
  ]
  v(0.45em, weak: true)
}
#show heading.where(level: 2): it => {
  v(0.9em, weak: true)
  text(fill: navy, size: 11.5pt, weight: "bold")[#it]
  v(0.25em, weak: true)
}
#show heading.where(level: 3): it => {
  v(0.6em, weak: true)
  text(fill: navy, size: 11pt, style: "italic")[#it]
  v(0.15em, weak: true)
}

// ── Title block ──────────────────────────────────────────────────
#v(0.5cm)
#align(center)[
  #text(size: 22pt, weight: "bold", fill: navy)[Minkowski Functionals]
  #v(0.5em)
  #text(size: 13pt, style: "italic")[
    A First-Principles Guide: from "what is shape?" to \
    non-Gaussianity in cosmology
  ]
  #v(0.9em)
  #text(size: 12pt)[*Kazi Abu Rousan*]
  #v(0.3em)
  #text(size: 10pt, fill: gray)[#datetime.today().display("[day padding:none] [month repr:long] [year]")]
]
#v(0.5em)
#line(length: 100%, stroke: 0.5pt + navy)
#v(0.5em)

// ── Abstract ─────────────────────────────────────────────────────
#block(inset: (x: 0.8cm), below: 1em)[
  #text(size: 10.5pt)[
    *Abstract.* This note builds the idea of _Minkowski functionals_ (MFs) from
    the ground up, assuming no prior acquaintance with "morphology." We start with
    the everyday question of how to put numbers on _shape_, distil three properties
    any honest shape-descriptor must have, and arrive at Hadwiger's theorem, which
    shows that in $d$ dimensions there are exactly $d+1$ such descriptors. We give a
    self-contained primer on curvature (principal, mean, Gaussian), develop two
    independent but equivalent definitions via the _Steiner inflation_ picture and
    the _curvature-integral_ picture, and work through explicit examples in 2D and
    3D. We then cross the bridge to cosmology via excursion sets, derive the exact
    Gaussian predictions and their Hermite-polynomial structure from first principles,
    and show how deviations encode non-Gaussianity — phase information completely
    invisible to the power spectrum.
  ]
]
#line(length: 100%, stroke: 0.4pt)
#v(0.5em)

// ── Table of contents ────────────────────────────────────────────
#outline(depth: 2, indent: 1.5em)
#pagebreak()

// ================================================================
= What is "morphology," really?
// ================================================================

The word *morphology* simply means _the study of form_: the bundle of properties
you would use to describe an object to someone who cannot see it, without revealing
where it sits or how it is oriented. Think about describing a cloud, a coastline,
or the cosmic web of galaxy filaments. You might say:

- "*It is big*" — a statement about *content* (area or volume);
- "*Its edge is long and ragged*" — a statement about the *boundary*;
- "*It bulges outward here and pinches inward there*" — a statement about *curvature*;
- "*It consists of three separate blobs, one with a hole through it*" — a statement about
  *topology*, i.e. connectivity.

Remarkably, that list is essentially complete. Content, boundary, curvature, and
connectivity are not an arbitrary collection: they are precisely the four Minkowski
functionals of a body in three dimensions. Making this precise — and showing why it is
true — is the aim of this document.

#ibox(title: "The physicist's reason to care")[
  A physicist wants *coordinate-free observables* — numbers that describe the object
  itself, independent of the coordinate system used to study it. Morphological descriptors
  are exactly that: they do not change if you translate or rotate the body. They are to
  _shape_ what a scalar invariant is to a tensor. This stands in stark contrast to, say,
  the Fourier modes of a field, whose individual values depend on the orientation of the
  coordinate axes.
]

// ================================================================
= What we demand of a shape descriptor
// ================================================================

Let $K$ be a "body" — a compact, reasonably regular chunk of space with a smooth
(or piecewise-smooth) boundary. Think of a filled ball, a cube, the region of the
sky where the CMB temperature exceeds some value, or a cluster of galaxies. A
*functional* $F$ is a rule that assigns a single real number $F(K)$ to each such
body. We will only accept $F$ as a *morphological* descriptor if it satisfies
three axioms.

#dbox(title: "The three Hadwiger axioms")[
  + *(M1) Motion invariance.* For any rigid motion (rotation + translation) $g$,
    $ F(g K) = F(K). $
  + *(M2) Additivity (inclusion–exclusion).* For any two bodies $A$ and $B$,
    $ F(A union B) = F(A) + F(B) - F(A inter B). $
  + *(M3) Continuity.* If a sequence of bodies $K_n$ converges to $K$ (meaning
    their boundaries settle without wild oscillations), then $F(K_n) -> F(K)$.
]

#ibox(title: "Reading the three axioms in words")[
  *(M1) Motion invariance.* The intrinsic shape of a coffee mug cannot depend on
  whether it is on the table or in your hand. This is the "coordinate-free" demand,
  and it is what distinguishes morphology from mere description: we measure _what
  the object is_, not _where it is_.

  *(M2) Additivity.* This is careful counting. When you assemble a region from two
  overlapping pieces, the quantity for the whole equals the sum for the parts _minus_
  the overlap counted twice. Volume obeys it; so does surface area once you account
  for the seam. Crucially, additivity is what makes MFs *locally computable*: you
  can scan a pixelated or HEALPix map cell by cell and accumulate one cell at a time,
  correcting for shared edges. Without this axiom, every global shape statistic would
  require storing the entire dataset simultaneously.

  *(M3) Continuity.* A tiny smooth deformation of the boundary should change the
  number only slightly. This eliminates pathological descriptors that jump
  discontinuously, and makes MFs robust to noise and to the finite pixelisation of
  real data.
]

It is worth pausing to notice how much these three axioms _exclude_. For example,
the number of pixels above a threshold (before any smoothing) can jump by ±1 with
an infinitesimal change in the field — so it fails (M3). Counts that depend on
orientation of the coordinate axes fail (M1). The fractal dimension of a coastline
is not additive in the sense of (M2). The Minkowski functionals are the class of
statistics that pass _all three_ simultaneously.

// ================================================================
= Hadwiger's theorem: exactly $d+1$ functionals exist
// ================================================================

Here is the structural miracle at the heart of the subject.

#thmbox(title: "Hadwiger's Characterisation Theorem (1957)")[
  In $RR^d$, every functional $F$ satisfying (M1)–(M3) is a *linear combination* of
  exactly $d+1$ fundamental functionals $W_0, W_1, dots, W_d$:
  $ F(K) = sum_(nu=0)^d c_nu W_nu(K). $ <eq-hadwiger>
  The $W_nu$ are the *Minkowski functionals* (also called _quermassintegrals_).
]

#ibox(title: "What this theorem is really saying")[
  Hadwiger's theorem says the Minkowski functionals form a *complete basis for
  morphology*. Suppose you devise a new, clever shape statistic. If it is
  coordinate-free, additive, and continuous, then no matter how sophisticated it
  looks, Hadwiger guarantees you have not discovered new geometric information —
  your statistic is secretly a weighted sum of the same $d+1$ numbers.

  Compare this with $n$-point correlation functions, which form an infinite tower
  of statistics. The MFs are a *finite, complete* alternative at the level of
  additive, continuous, motion-invariant descriptors. This is both a limitation
  (they do not capture everything) and a strength (they are the _complete_ capture
  of everything at this level, not an ad hoc selection).
]

In the dimensions most relevant to physics:

#figure(
  table(
    columns: (auto, auto, 1fr),
    align: (center, center, left),
    stroke: (x, y) => if y == 0 { (bottom: 0.5pt + navy) } else { none },
    fill: (x, y) => if y == 0 { def-bg } else { none },
    [*Dimension $d$*], [*No. of MFs*], [*What they measure*],
    [$d=1$ (a line segment)], [2], [length, endpoint count ($chi$)],
    [$d=2$ (a sky map)], [3], [area, perimeter, Euler characteristic ($chi$)],
    [$d=3$ (a 3D volume)], [4], [volume, surface area, integrated mean curvature, $chi$],
  ),
  caption: [The $d+1$ Minkowski functionals in each physical dimension.]
) <tab-mf-dims>

// ================================================================
= A short primer on curvature
// ================================================================

Two of the four 3D functionals are integrals of curvature, so we need to build
that concept honestly. Readers already comfortable with principal, mean, and
Gaussian curvature may skip to @sec-steiner.

== Curvature of a curve

Walk along a curve at unit speed. Your heading — the unit tangent vector — rotates
as you go. The rate of that rotation is the *curvature* $kappa$. A straight line
has $kappa = 0$. A circle of radius $R$ turns at a constant rate with
$kappa = 1 slash R$: a tight circle (small $R$) is highly curved, a vast circle
(large $R$) is nearly straight. The number $R = 1 slash kappa$ is the *radius of
curvature*.

== Curvature of a surface

At a point $P$ on a smooth surface, erect a knife-blade along the surface normal
and slice. The cut yields a plane curve, which has a curvature. Rotating the blade
around the normal changes that curvature. The largest and smallest values found are
the two *principal curvatures* $kappa_1 = 1 slash R_1$ and $kappa_2 = 1 slash R_2$.
From them we build two key combinations:

#dbox(title: "Mean and Gaussian curvature")[
  $
  H = 1/2 (kappa_1 + kappa_2) = 1/2 lr((1/R_1 + 1/R_2)),
  quad
  K_G = kappa_1 kappa_2 = 1/(R_1 R_2).
  $
  $H$ is the *mean curvature*; $K_G$ is the *Gaussian curvature*.
]

The figure below illustrates the four canonical surface types:

#figure(
  canvas({
    import draw: *
    // ── helper ──────────────────────────────────────────────
    let label-pt(pos, body, anchor: "north") = {
      content(pos, text(size: 9pt)[#body], anchor: anchor)
    }

    // Panel spacing
    let dx = 4.0

    // ── (a) Flat plane  H=0, K=0 ────────────────────────────
    let ox = 0.0
    rect((ox, 0.2), (ox + 2.4, 1.8), fill: mgray.lighten(40%), stroke: 0.5pt + gray)
    line((ox + 0.4, 0.5), (ox + 0.4, 1.5), stroke: (paint: col4, thickness: 1.2pt))
    label-pt((ox + 1.2, -0.15), [$H=0,quad K_G=0$])
    label-pt((ox + 1.2, 2.1), [*Flat plane*], anchor: "south")

    // ── (b) Sphere  H>0, K>0 ────────────────────────────────
    let ox = dx
    circle((ox + 1.2, 1.0), radius: 0.9,
           fill: col1.lighten(75%), stroke: (paint: col1, thickness: 0.7pt))
    // two meridians to suggest curvature
    for ang in (30deg, 90deg, 150deg) {
      let x1 = ox + 1.2 + 0.9 * calc.cos(ang)
      let y1 = 1.0 + 0.9 * calc.sin(ang)
      let x2 = ox + 1.2 + 0.9 * calc.cos(ang + 180deg)
      let y2 = 1.0 + 0.9 * calc.sin(ang + 180deg)
      line((x1, y1), (x2, y2),
           stroke: (paint: col1.lighten(30%), thickness: 0.4pt, dash: "dashed"))
    }
    // normal at top
    line((ox + 1.2, 1.0), (ox + 1.2, 2.35),
         stroke: (paint: col4, thickness: 1.2pt), mark: (end: ">"))
    label-pt((ox + 1.2, -0.15), [$H>0,quad K_G>0$])
    label-pt((ox + 1.2, 2.5), [*Sphere (dome)*], anchor: "south")

    // ── (c) Cylinder  H>0, K=0 ──────────────────────────────
    let ox = 2.0 * dx
    // helper: manual ellipse polyline
    let ell(ecx, ecy, erx, ery, n: 28) = range(n + 1).map(i => {
      let th = i / n * 2 * calc.pi
      (ecx + erx * calc.cos(th), ecy + ery * calc.sin(th))
    })
    // fill side
    rect((ox + 0.5, 0.3), (ox + 1.9, 1.7),
         fill: col2.lighten(80%), stroke: none)
    // bottom oval (dashed)
    line(..ell(ox + 1.2, 0.3, 0.7, 0.22),
         stroke: (paint: col2, thickness: 0.4pt, dash: "dashed"))
    // side edges
    line((ox + 0.5, 0.3), (ox + 0.5, 1.7), stroke: col2 + 0.7pt)
    line((ox + 1.9, 0.3), (ox + 1.9, 1.7), stroke: col2 + 0.7pt)
    // top oval (filled + stroked)
    let top-pts = ell(ox + 1.2, 1.7, 0.7, 0.22)
    line(..top-pts, fill: col2.lighten(70%), stroke: col2 + 0.7pt)
    // normal
    line((ox + 1.9, 1.0), (ox + 2.9, 1.0),
         stroke: col4 + 1.2pt, mark: (end: ">"))
    label-pt((ox + 1.2, -0.15), [$H>0,quad K_G=0$])
    label-pt((ox + 1.2, 2.5), [*Cylinder*], anchor: "south")

    // ── (d) Saddle  H≈0, K<0 ────────────────────────────────
    let ox = 3.0 * dx
    // approximate a saddle with bezier-ish lines
    let pts-u = range(13).map(i => {
      let t = -1.0 + i * (2.0 / 12.0)
      let x = ox + 1.2 + t * 0.85
      let y = 1.0 + t * t * 0.45 + 0.05
      (x, y)
    })
    let pts-v = range(13).map(i => {
      let t = -1.0 + i * (2.0 / 12.0)
      let x = ox + 1.2 + t * 0.85
      let y = 1.0 - t * t * 0.45 + 0.05
      (x, y)
    })
    line(..pts-u, stroke: col3 + 1.2pt)
    line(..pts-v, stroke: col3 + 1.2pt)
    // cross-sections
    for j in range(5) {
      let t = -0.8 + j * 0.4
      let mid-y = 1.0 + t * t * 0.45 + 0.05
      let x0 = ox + 1.2 - 0.85
      let x1 = ox + 1.2 + 0.85
      // interpolate crossing curve
      let xs = range(9).map(i => {
        let s = -1.0 + i * (2.0 / 8.0)
        let xp = ox + 1.2 + s * 0.85
        let yp = 1.0 - s * s * 0.45 + 0.05 + t * 0.55
        (xp, yp)
      })
      line(..xs, stroke: (paint: col3.lighten(50%), thickness: 0.5pt))
    }
    label-pt((ox + 1.2, -0.15), [$H approx 0,quad K_G<0$])
    label-pt((ox + 1.2, 2.5), [*Saddle*], anchor: "south")

    // ── Bottom annotations ───────────────────────────────────
    content((1.2, -0.75), text(size: 8.5pt, fill: gray)[Both flat])
    content((dx + 1.2, -0.75), text(size: 8.5pt, fill: gray)[Dome; both $kappa>0$])
    content((2*dx + 1.2, -0.75), text(size: 8.5pt, fill: gray)[One flat, one curved])
    content((3*dx + 1.2, -0.75), text(size: 8.5pt, fill: gray)[Opposite signs])
  }),
  caption: [
    The four canonical surface types classified by mean and Gaussian curvature.
    A flat plane has $H = 0$ and $K_G = 0$. A sphere has both principal curvatures
    equal and positive: $H > 0$, $K_G > 0$. A cylinder has one flat direction:
    $K_G = 0$ but $H > 0$. A saddle surface bends upward in one principal direction
    and downward in the other: $K_G < 0$.
  ]
) <fig-curvature-types>

#ibox(title: "Telling the two curvatures apart")[
  *Mean curvature $H$* answers "_which way, and how strongly, does the surface
  bend on average?_" On the outside of a sphere it bends the same way in every
  direction, so $H > 0$. On a flat sheet $H = 0$. On the inside of a tube or
  the neck joining two blobs, the surface bends "backwards," giving $H < 0$.
  The sign of $H$ thus distinguishes outward lumps from inward necks.

  *Gaussian curvature $K_G$* answers "_what kind of point is this?_"
  $K_G > 0$: a dome (sphere-like), both principal curvatures same sign.
  $K_G = 0$: a cylinder or plane, one flat direction.
  $K_G < 0$: a saddle (mountain pass), opposite bending directions.
  Gauss's _Theorema Egregium_ shows that $K_G$ is _intrinsic_: it can be measured
  by an ant living on the surface, purely from internal distances, without reference
  to the ambient 3D space.
]

== The Gauss–Bonnet theorem: curvature encodes topology <sec-gauss-bonnet>

The deepest fact about Gaussian curvature is that its integral over a surface is not
a free geometric quantity — it is locked, via the topology of the surface, to a
simple integer. The full theorem, valid for a surface $Sigma$ that may have a
boundary $partial Sigma$, reads:

$ integral_Sigma K_G d A + integral_(partial Sigma) kappa_g d s + sum_i theta_i = 2 pi chi(Sigma), $ <eq-gb-full>

where $kappa_g$ is the *geodesic curvature* of the boundary curve $partial Sigma$,
the $theta_i$ are the *exterior angles* at any corner points of the boundary, and
$chi$ is the *Euler characteristic*. When the surface has no boundary
($partial Sigma = emptyset$), both extra terms vanish and one obtains the classic
closed-surface form:

$ 1/(2 pi) integral_Sigma K_G d A = chi(Sigma). $ <eq-gb>

For a sphere $chi = 2$; for a torus $chi = 0$; each additional handle reduces
$chi$ by 2. You can deform the surface arbitrarily — pushing curvature from one
region to another is always exactly compensated elsewhere, and the integral never
changes. The geodesic curvature $kappa_g$ measures how much a boundary curve bends
_within_ the surface (as opposed to bending out of it); for a geodesic boundary
(the boundary follows the shortest path on the surface) it is zero.

This is the geometric bridge from curvature (a local, smooth quantity) to topology
(a global, integer quantity), and it is precisely why one of the Minkowski
functionals is a pure connectivity counter.

// ================================================================
= The Minkowski sum <sec-minksum>
// ================================================================

The Steiner formula (defined in the next section) rests on two ideas: the *unit
ball* and the *Minkowski sum*. We pause to build both carefully.

== The unit ball and its scaling

A *ball* of radius $epsilon$ centred at $bold(c)$ is the set of all points no
farther than $epsilon$ from $bold(c)$:
$ B(bold(c), epsilon) = {bold(x) : |bold(x) - bold(c)| <= epsilon}. $

#ibox(title: "Ball vs sphere — do not confuse them")[
  A *ball* is the solid filled region; a *sphere* is only its surface (hollow shell).
  The ball of radius $R$ in 3D has volume $4/3 pi R^3$, while its boundary sphere
  has area $4 pi R^2$. Throughout this note $epsilon B$ means the solid ball. The
  *unit ball* $B$ is the ball of radius 1 about the origin, and $epsilon B$ is that
  ball scaled to radius $epsilon$.
]

== The Minkowski sum

#dbox(title: "Minkowski sum")[
  Given two sets $A$ and $B$ in $RR^d$, their *Minkowski sum* is
  $ A plus.o B = {bold(a) + bold(b) : bold(a) in A,, bold(b) in B}. $
]

#ibox(title: "Two equivalent pictures: stamping and sweeping")[
  - *Stamping.* Pin the origin of $B$ at each point $bold(a) in A$ and drop a
    copy of $B$ there. Take the union of all copies. (By commutativity you can
    equivalently stamp $A$ at every point of $B$.)
  - *Sweeping.* Slide $B$ so its reference point visits every point of $A$. The
    region swept out is $A plus.o B$.

  Both pictures reveal the same key fact: the Minkowski sum is a _uniform fattening_
  of $A$ by the "shape" of $B$. When $B$ is a ball of radius $epsilon$, the sum
  $A plus.o epsilon B$ is the set of all points within distance $epsilon$ of $A$.
]

#figure(
  canvas({
    import draw: *
    let pi = calc.pi

    // ── (A) original equilateral triangle ─────────────────
    let Ax = 0.6; let Ay = 0.3
    let Bx = 3.0; let By = 0.3
    let Cx = 1.8; let Cy = 2.38   // equilateral: h = side * sqrt(3)/2

    line((Ax,Ay),(Bx,By),(Cx,Cy), close: true,
         fill: col1.lighten(72%), stroke: col1 + 0.9pt)
    content((1.8, 1.0), text(size: 10pt, fill: col1)[$A$])

    // ── Plus sign ─────────────────────────────────────────
    content((3.8, 1.3), text(size: 20pt)[$plus.o$])

    // ── disk ──────────────────────────────────────────────
    circle((4.9, 1.3), radius: 0.40,
           fill: col2.lighten(55%), stroke: col2 + 0.8pt)
    content((4.9, 0.65), text(size: 9pt, fill: col2)[$epsilon B$])

    // ── equals sign ───────────────────────────────────────
    content((5.9, 1.3), text(size: 20pt)[$=$])

    // ── Rounded triangle = correct Minkowski sum ──────────
    // place it to the right of the equals sign
    let rAx = Ax + 6.5; let rAy = Ay
    let rBx = Bx + 6.5; let rBy = By
    let rCx = Cx + 6.5; let rCy = Cy
    let eps = 0.40

    // outward unit normals for each edge
    let nABx = 0.0;    let nABy = -1.0
    let nBCx = 0.866;  let nBCy = 0.5
    let nCAx = -0.866; let nCAy = 0.5

    // sample a CCW arc of radius eps centred at (vcx,vcy)
    // from start-deg to stop-deg (going CCW, stop may be > 360)
    let arc-s(vcx, vcy, sd, ed, n) = {
      let span = if ed >= sd { ed - sd } else { ed + 360.0 - sd }
      range(n + 1).map(i => {
        let ang = (sd + i / n * span) * pi / 180.0
        (vcx + eps * calc.cos(ang), vcy + eps * calc.sin(ang))
      })
    }

    // full rounded-triangle boundary going CCW
    let rnd = (
      arc-s(rAx, rAy, 150.0, 270.0, 16)
      + ((rAx + eps*nABx, rAy + eps*nABy), (rBx + eps*nABx, rBy + eps*nABy))
      + arc-s(rBx, rBy, 270.0, 390.0, 16)
      + ((rBx + eps*nBCx, rBy + eps*nBCy), (rCx + eps*nBCx, rCy + eps*nBCy))
      + arc-s(rCx, rCy, 30.0, 150.0, 16)
      + ((rCx + eps*nCAx, rCy + eps*nCAy), (rAx + eps*nCAx, rAy + eps*nCAy))
    )
    line(..rnd, close: true,
         fill: acc.lighten(70%), stroke: acc + 0.8pt)

    // inner triangle outline (dashed) for reference
    line((rAx,rAy),(rBx,rBy),(rCx,rCy), close: true,
         fill: none, stroke: (paint: acc.darken(20%), thickness: 0.4pt, dash: "dashed"))

    content((rCx, rAy + 0.85), text(size: 9pt, fill: acc)[$A plus.o epsilon B$])

    // ── epsilon double-arrow on right side ─────────────────
    let arx = rBx + 0.05; let ary = rBy + 0.5
    line((arx, ary),(arx + eps, ary),
         stroke: gray + 0.55pt, mark: (start: ">", end: ">"))
    content((arx + eps / 2, ary - 0.32), text(size: 8pt, fill: gray)[$epsilon$])
  }),
  caption: [
    The Minkowski sum $A plus.o epsilon B$ of a triangle $A$ with a small disc
    $epsilon B$. Each straight edge (dashed inner outline) slides outward by $epsilon$;
    each corner is rounded by a circular arc of radius $epsilon$. The result is the
    _parallel body_ of $A$: the set of all points within distance $epsilon$ of the
    original triangle.
  ]
) <fig-minksum>

== Useful identities for Minkowski sums

A few facts follow directly from the definition:

- *Commutativity and associativity:* $A plus.o B = B plus.o A$ and $(A plus.o B) plus.o C = A plus.o (B plus.o C)$.
- *Translation:* $A plus.o {bold(t)} = A + bold(t)$ (a shift by $bold(t)$).
- *Ball addition:* $B_r plus.o B_s = B_(r+s)$ (radii add). So inflating a ball of radius $R$ by $epsilon$ gives $B_{R+epsilon}$, a one-line identity.
- *Segment + disc = capsule:* sweeping a filled disc along a segment produces a "stadium" shape with semicircular caps.

#pbox(title: "Connection to image processing and robotics")[
  If you have encountered _morphological dilation_ in image processing, you already
  know the Minkowski sum: dilating a binary image by a structuring element _is_
  the Minkowski sum. The additivity axiom (M2) is what allows the dilation to be
  computed by scanning pixels one at a time. In robotics, the region a robot cannot
  enter (the configuration-space obstacle) is the Minkowski sum of the physical
  obstacle with the robot's shape. The same operation underlies collision detection
  and path planning in autonomous vehicles.
]

// ================================================================
= Definition I — the Steiner inflation formula <sec-steiner>
// ================================================================

Take a convex body $K$ and inflate it: form its parallel body
$K plus.o epsilon B$ by adding a uniform layer of thickness $epsilon$. Then
measure the volume (area in 2D) of the inflated body. Steiner showed in 1840 that
this volume is a _polynomial_ in $epsilon$.

#dbox(title: "Steiner's formula")[
  $ "Vol"(K plus.o epsilon B) = sum_(nu=0)^d binom(d, nu) W_nu(K) epsilon^nu. $ <eq-steiner>
  The coefficients $W_0, dots, W_d$ are (up to the binomial prefactors) the *Minkowski functionals*.
]

#ibox(title: "Why inflation sorts geometry by powers of ε")[
  When you fatten a body, the new material arrives in geometrically distinct layers:
  - The $epsilon^0$ term is the original body — its *content* (volume or area).
  - The $epsilon^1$ layer is a uniform slab over the boundary, so its thickness is uniform and its volume is proportional to the *surface area*.
  - Higher powers fill the rounded edges and corners; they are set by how the boundary *curves* (and the top power packages up the *topology*).

  The Steiner polynomial literally *sorts a body's geometry by how strongly each feature responds to inflation*, and reading off the coefficients yields the functionals one by one.
]

== Worked example: a 3D ball of radius $R$

Inflating a ball grows its radius to $R + epsilon$, so

$ "Vol" = 4/3 pi (R + epsilon)^3
  = underbrace(4/3 pi R^3)_(epsilon^0)
  + underbrace(4 pi R^2)_(epsilon^1) epsilon
  + underbrace(4 pi R)_(epsilon^2) epsilon^2
  + underbrace(4/3 pi)_(epsilon^3) epsilon^3. $

Matching to $sum binom(3,nu) W_nu epsilon^nu$ with $binom(3,nu) = {1,3,3,1}$:
$ W_0 = 4/3 pi R^3 quad ("volume"),
  quad W_1 = 4/3 pi R^2 quad (1/3 "surface"),
  quad W_2 = 4/9 pi R,
  quad W_3 = 4/9 pi. $

Note that $W_3 = 4 pi slash 9$ is _independent of $R$_ — a hallmark of a topological
quantity. (For a convex body $chi = 1$, and the last functional always equals
$omega_d slash (2pi)$ times $chi$.)

== Worked example: a 2D square of side $a$

Inflating a square produces four rectangular slabs along the edges and four
quarter-disc corners that together assemble into one full disc:

$ "Area" = underbrace(a^2)_(epsilon^0) + underbrace(4a)_(epsilon^1) epsilon
  + underbrace(pi)_(epsilon^2) epsilon^2. $

Matching $W_0 + 2W_1 epsilon + W_2 epsilon^2$:
$ W_0 = a^2 quad ("area"),
  quad quad W_1 = 2a = 1/2 "perimeter",
  quad quad W_2 = pi = pi chi quad (chi = 1). $

The four corner arcs together turn through exactly one full circle; this is the
entire Euler characteristic budget, confirming that corners carry topology.

#figure(
  canvas({
    import draw: *
    let ep = 0.68
    let x0 = 0.9; let y0 = 0.9
    let x1 = 3.9; let y1 = 3.5

    // 1) corner discs — full circles; slabs and square (drawn next) cover 3/4
    //    of each circle, leaving only the outer quarter-disc visible.
    circle((x0, y0), radius: ep, fill: col4.lighten(38%), stroke: none)
    circle((x1, y0), radius: ep, fill: col4.lighten(38%), stroke: none)
    circle((x0, y1), radius: ep, fill: col4.lighten(38%), stroke: none)
    circle((x1, y1), radius: ep, fill: col4.lighten(38%), stroke: none)

    // 2) four flat slabs on top of the corner pieces
    rect((x0, y0 - ep), (x1, y0), fill: col2.lighten(48%), stroke: none)  // bottom
    rect((x0, y1),      (x1, y1 + ep), fill: col2.lighten(48%), stroke: none)  // top
    rect((x0 - ep, y0), (x0, y1), fill: col2.lighten(48%), stroke: none)  // left
    rect((x1, y0),      (x1 + ep, y1), fill: col2.lighten(48%), stroke: none)  // right

    // 3) original square on top of everything
    rect((x0, y0), (x1, y1), fill: col1.lighten(72%), stroke: col1 + 1pt)
    content(((x0+x1)/2, (y0+y1)/2), text(fill: col1)[$K$])

    // 4) outer dashed boundary (rounded rect)
    rect((x0 - ep, y0 - ep), (x1 + ep, y1 + ep),
         fill: none, stroke: (paint: acc, thickness: 1.6pt), radius: ep)

    // 5) epsilon double-arrow
    let arx = x1 + 0.06; let ary = (y0 + y1) / 2
    line((arx, ary), (arx + ep - 0.06, ary),
         stroke: gray + 0.6pt, mark: (start: ">", end: ">"))
    content((arx + ep / 2, ary - 0.38), text(size: 8.5pt)[$epsilon$])

    // 6) labels — slabs (top and bottom), corner (with arrow)
    content(((x0+x1)/2, y0 - ep/2 - 0.05),
            text(size: 8.5pt, fill: col2.darken(25%))[flat slab $prop$ _perimeter_],
            anchor: "center")
    content(((x0+x1)/2, y1 + ep/2 + 0.2),
            text(size: 8.5pt, fill: col2.darken(25%))[flat slab $prop$ _perimeter_],
            anchor: "center")
    // corner label off to the side with pointer
    let lbx = x1 + ep + 0.6; let lby = y0 - ep - 0.35
    content((lbx, lby), text(size: 8.5pt, fill: col4.darken(25%))[corner arc $prop$ $chi$],
            anchor: "west")
    line((lbx - 0.05, lby + 0.15), (x1 + ep * 0.6, y0 - ep * 0.6),
         stroke: col4.lighten(20%) + 0.5pt, mark: (end: ">"))
  }),
  caption: [
    Inflating a square by $epsilon$. The added area decomposes into: four flat slabs
    (orange, proportional to the original perimeter — the $epsilon^1$ coefficient)
    and four corner quarter-discs (green) that assemble into one full disc — the
    $epsilon^2$ coefficient, which carries the Euler characteristic $chi = 1$.
    Each power of $epsilon$ isolates a distinct geometric feature.
  ]
) <fig-steiner>

== Worked example: a 3D cube of side $a$

A cube carries no curvature on its flat faces; all curvature is localised on its
12 edges and 8 vertices. The inflated parallel body decomposes into four types of pieces:

#figure(
  table(
    columns: (1.8fr, auto, 1.5fr, auto, 1.8fr),
    align: (left, center, left, center, left),
    stroke: none,
    fill: (x, y) => if y == 0 { def-bg } else if calc.even(y) { lgray } else { none },
    [*Piece*], [*Count*], [*Each contributes*], [*Power*], [*Assembles into*],
    [Bulk cube], [1], [$a^3$], [$epsilon^0$], [*volume*],
    [Face slabs], [6], [$a^2 epsilon$], [$epsilon^1$], [*surface* $6a^2$],
    [Edge quarter-cylinders], [12], [$frac(pi,4) epsilon^2 a$], [$epsilon^2$], [*mean curvature*],
    [Corner eighth-balls], [8], [$frac(1,8) dot frac(4,3) pi epsilon^3$], [$epsilon^3$], [*topology* ($8 times 1/8 = 1$)],
  ),
  caption: [Decomposition of the cube's inflated parallel body into four geometric piece types, one for each Minkowski functional.]
) <tab-cube>

Adding all pieces and matching the Steiner coefficients:
$ W_0 = a^3, quad W_1 = 2a^2 = 1/3(6a^2), quad W_2 = pi a/3, quad W_3 = 4pi/9. $

== Table of Minkowski functionals for common shapes

#figure(
  table(
    columns: (1.4fr, 1fr, 1fr, 1fr, 1fr),
    align: (left, center, center, center, center),
    stroke: none,
    fill: (x, y) => if y == 0 { def-bg } else if calc.even(y) { lgray } else { none },
    [*Shape*], [$W_0$ (Vol)], [$W_1 prop "SA"$], [$W_2 prop "MC"$], [$W_3 = chi$],
    [Ball, radius $R$], [$4/3 pi R^3$], [$4/3 pi R^2$], [$4/9 pi R$], [$4/9 pi$],
    [Cube, side $a$], [$a^3$], [$2a^2$], [$pi a/3$], [$4pi/9$],
    [Cylinder $r, h$], [$pi r^2 h$], [$pi r h/3 + pi r^2/3$], [—], [$4pi/9$],
    [Torus $R, r$], [$2 pi^2 R r^2$], [—], [—], [$0$],
    [Disc, radius $R$ (2D)], [$pi R^2$], [$pi R / 2$], [$pi$], [],
    [Rectangle $a times b$ (2D)], [$a b$], [$(a+b)/2$], [$pi$], [],
  ),
  caption: [
    Minkowski functionals for common shapes (3D unless noted). MC denotes integrated
    mean curvature. The torus has $chi = 0$ because it has one handle; the cylinder
    capped at both ends has $chi = 2$ like a sphere.
  ]
) <tab-mf-shapes>

// ================================================================
= Definition II — the curvature-integral form
// ================================================================

The Steiner coefficients can be rewritten as surface integrals over $partial K$,
which is where the physical meaning becomes most vivid. We use the normalisation
common in cosmology (Schmalzing & Buchert 1997).

== Three-dimensional functionals

$
V_0 &= integral_K d^3 x &&quad "volume" \
V_1 &= 1/6 integral_(partial K) d S &&quad prop "surface area" \
V_2 &= 1/(6 pi) integral_(partial K) H , d S, quad H = 1/2 lr((1/R_1 + 1/R_2)) &&quad prop "integrated mean curvature" \
V_3 &= 1/(4 pi) integral_(partial K) (d S)/(R_1 R_2) &&quad = "Euler characteristic" chi
$

#ibox(title: "The four 3D functionals in plain words")[
  *$V_0$ — volume.* How much "stuff" is enclosed. Pure content, sensitive only to
  the overall scale of the region.

  *$V_1$ — surface area.* How much skin wraps the volume. For a fixed volume a ball
  has the least surface; a sponge or a tangle of filaments has enormously more. $V_1$
  measures how "spread out and frilly" the boundary is. Two regions can have identical
  volumes and power spectra yet differ in surface area if one is a compact sphere and
  the other is a fractal-like web.

  *$V_2$ — integrated mean curvature.* Sums up the bending of the boundary. It is
  the first functional that can distinguish a fat, compact blob (mostly outward bending;
  $V_2 > 0$) from a network of thin tunnels (lots of inward neck-like bending). It is
  sensitive to elongation and pinching — two shapes invisible to $V_0$ and $V_1$ alone.

  *$V_3$ — Euler characteristic.* By Gauss–Bonnet @eq-gb the integral of Gaussian
  curvature is a topological integer:
  $ chi = hash("separate pieces") - hash("tunnels / handles") + hash("enclosed cavities"). $
  This is the *genus statistic* of large-scale structure. It cannot change continuously:
  it can only jump when the topology changes (a piece merges, a tunnel opens or closes).
]

#exbox(title: "Numerical example: 3D sphere of radius $R$")[
  On $partial K = S^2_R$ both principal radii equal $R$, so $R_1 = R_2 = R$ everywhere.
  The surface element is $d S = R^2 sin theta , d theta , d phi$, giving
  $integral_(partial K) d S = 4 pi R^2$.

  *$V_0$ — volume.*
  $ V_0 = integral_K d^3 x = integral_0^R 4 pi r^2 d r = frac(4,3) pi R^3. $

  *$V_1$ — surface area term.* The surface area is $4 pi R^2$, so
  $ V_1 = frac(1,6) integral_(partial K) d S = frac(1,6)(4 pi R^2) = frac(2,3) pi R^2. $

  *$V_2$ — integrated mean curvature.* With $H = frac(1,2)(frac(1,R_1)+frac(1,R_2)) = frac(1,R)$ constant on $S^2_R$:
  $ V_2 = frac(1,6 pi) integral_(partial K) H , d S
       = frac(1,6 pi) dot frac(1,R) dot 4 pi R^2
       = frac(2R,3). $

  *$V_3$ — Euler characteristic.* Gaussian curvature $K = 1\/(R_1 R_2) = 1\/R^2$:
  $ V_3 = frac(1,4 pi) integral_(partial K) frac(d S,R_1 R_2)
       = frac(1,4 pi) dot frac(1,R^2) dot 4 pi R^2 = 1 quad (= chi, "one solid piece"). $

  *Numerical values for $R = 1$ cm:*
  #align(center)[
    #table(
      columns: 5,
      stroke: none,
      fill: (x, y) => if y == 0 { def-bg } else if calc.even(y) { lgray } else { none },
      align: center,
      [*Functional*], [$V_0$], [$V_1$], [$V_2$], [$V_3$],
      [*Formula*],
        [$frac(4,3)pi R^3$], [$frac(2,3)pi R^2$], [$frac(2,3)R$], [$1$],
      [*Value ($R=1$)*],
        [$frac(4pi,3) approx 4.19 "cm"^3$],
        [$frac(2pi,3) approx 2.09 "cm"^2$],
        [$2\/3 approx 0.667 "cm"$],
        [$1$],
    )
  ]
  Note: $V_3 = chi = 1$ is _independent of $R$_ — topology is scale-free.
]

== Two-dimensional functionals

For a map (a patch of sky or a 2D projected density field), $d = 2$ gives three
functionals on a region $Q$ with boundary curve $partial Q$:

$
V_0 = integral_Q d a &&quad "area" \
V_1 = 1/4 integral_(partial Q) d ell &&quad prop "perimeter (boundary length)" \
V_2 = 1/(2 pi) integral_(partial Q) kappa , d ell &&quad = "Euler characteristic" chi
$

where $kappa$ is the geodesic curvature of the boundary curve.

#ibox(title: "The three 2D functionals in plain words")[
  *$V_0$ — area.* What fraction of the map the hot (or dense) region covers.

  *$V_1$ — perimeter.* The total length of the iso-contours bounding the region.
  A smooth disc has the minimum perimeter for its area; a highly crinkled boundary
  has far more. $V_1$ measures the _roughness and complexity_ of the contours — the
  "coastline length."

  *$V_2$ — Euler characteristic.* By Gauss–Bonnet, the integrated turning of all
  boundary curves is an integer:
  $ chi = hash("isolated spots") - hash("holes punched in them"). $
  A sky covered in many separate hot islands has large positive $V_2$; a mostly-hot
  sky with cold pinholes has $V_2 < 0$.
]

#exbox(title: "Numerical example: 2D disc of radius $R$")[
  The boundary $partial Q$ is a circle of circumference $2 pi R$.
  Geodesic curvature of a circle of radius $R$ embedded in the flat plane: $kappa = 1\/R$.

  *$V_0$ — area.*
  $ V_0 = integral_Q d a = integral_0^R 2 pi r , d r = pi R^2. $

  *$V_1$ — perimeter term.* With $integral_(partial Q) d ell = 2 pi R$:
  $ V_1 = frac(1,4) integral_(partial Q) d ell = frac(1,4)(2 pi R) = frac(pi R,2). $

  *$V_2$ — Euler characteristic.* Gauss–Bonnet on a flat disc gives $integral.cont kappa , d ell = 2 pi$:
  $ V_2 = frac(1,2 pi) integral_(partial Q) kappa , d ell
       = frac(1,2 pi) dot frac(1,R) dot 2 pi R = 1 quad (= chi). $

  *Numerical values:*
  #align(center)[
    #table(
      columns: 4,
      stroke: none,
      fill: (x, y) => if y == 0 { def-bg } else if calc.even(y) { lgray } else { none },
      align: center,
      [*Functional*], [$V_0$], [$V_1$], [$V_2$],
      [*Formula*], [$pi R^2$], [$pi R slash 2$], [$1$],
      [$R = 1$], [$pi approx 3.14$], [$pi\/2 approx 1.57$], [$1$],
      [$R = 3$], [$9pi approx 28.3$], [$3pi\/2 approx 4.71$], [$1$],
    )
  ]
]

#exbox(title: "Numerical example: 2D rectangle $a times b$")[
  Boundary: four straight sides (geodesic curvature $kappa = 0$) and four right-angle
  corners (each turning through an exterior angle of $pi\/2$, contributing a delta-function
  curvature).

  *$V_0$ — area.*
  $ V_0 = a b. $

  *$V_1$ — half-perimeter.*
  $ V_1 = frac(1,4) integral_(partial Q) d ell = frac(1,4) dot 2(a + b) = frac(a+b,2). $

  *$V_2$ — Euler characteristic.* The total turning $integral.cont kappa , d ell = 0$ (sides)
  $+ 4 times (pi\/2)$ (corners) $= 2pi$ by the exterior-angle theorem for convex polygons:
  $ V_2 = frac(1,2 pi) dot 2 pi = 1 quad (= chi). $

  *Numerical values for $a = 4$, $b = 3$:*
  $ V_0 = 12, quad V_1 = frac(4+3,2) = 3.5, quad V_2 = 1. $

  *Key insight:* $V_2 = 1$ for _any_ simply connected 2D region (disc, rectangle, triangle, …)
  and $V_3 = 1$ for any convex 3D body. The topological functional is insensitive to
  shape — that information lives in $V_0$ and $V_1$.
]

// ================================================================
= The Euler characteristic, concretely
// ================================================================

Because $V_2$ (in 2D) and $V_3$ (in 3D) are purely topological, they deserve a
careful picture.

#figure(
  canvas({
    import draw: *
    let W = 14.0

    // ── Left panel: meatball (χ > 0) ──────────────────────
    rect((0, -0.2), (W / 2 - 0.2, 3.8),
         fill: lgray, stroke: gray + 0.3pt, radius: 2pt)
    content((W / 4, 3.5), text(fill: acc, weight: "bold", size: 10pt)[Meatball  $chi > 0$])
    // blobs
    let blobs = ((1.0, 1.5, 0.65), (2.6, 2.2, 0.5), (2.0, 0.8, 0.6), (3.8, 1.3, 0.55), (4.8, 2.1, 0.4))
    for (bx, by, br) in blobs {
      fill(acc.lighten(65%)); stroke(acc + 0.7pt)
      circle((bx, by), radius: br)
    }
    content((2.8, -0.6), text(size: 9pt)[isolated clumps, no holes])
    content((2.8, -0.95), text(size: 9pt, fill: acc)[$chi = #(blobs.len()) > 0$])

    // ── Right panel: sponge (χ < 0) ───────────────────────
    let ox = W / 2 + 0.2
    rect((ox, -0.2), (W, 3.8),
         fill: lgray, stroke: gray + 0.3pt, radius: 2pt)
    content((ox + (W / 2 - ox) / 2 + W / 4, 3.5),
            text(fill: col4, weight: "bold", size: 10pt)[Sponge  $chi < 0$])
    // big filled region with holes
    fill(col4.lighten(60%)); stroke(col4 + 0.7pt)
    rect((ox + 0.15, 0.15), (W - 0.15, 3.1), radius: 3pt)
    // holes
    let holes = ((ox + 1.0, 0.8), (ox + 2.2, 1.7), (ox + 3.0, 0.7),
                 (ox + 3.9, 1.9), (ox + 1.5, 2.5))
    for (hx, hy) in holes {
      fill(lgray); stroke(col4 + 0.6pt)
      circle((hx, hy), radius: 0.38)
    }
    content((ox + (W - ox) / 2, -0.6), text(size: 9pt)[one connected body, riddled with holes])
    content((ox + (W - ox) / 2, -0.95),
            text(size: 9pt, fill: col4)[$chi = 1 - #(holes.len()) = #(1 - holes.len()) < 0$])
  }),
  caption: [
    The Euler characteristic distinguishes a "meatball" topology ($chi > 0$: many
    disconnected clumps) from a "sponge" topology ($chi < 0$: one multiply-connected
    body riddled with holes). The power spectrum cannot tell these apart if their two-point
    statistics coincide; $V_2$ or $V_3$ can.
  ]
) <fig-topology>

#ibox(title: "Reading off χ by hand")[
  Count the pieces, subtract the holes (in 2D) or handles/tunnels (in 3D). In the
  left panel of @fig-topology: five pieces, no holes, so $chi = 5 > 0$. In the
  right panel: one piece, five holes, so $chi = 1 - 5 = -4 < 0$. As you sweep a
  threshold from $-infinity$ to $+infinity$, the field transitions between these
  regimes, and the _shape of that transition curve_ $V_2(nu)$ or $V_3(nu)$ is a
  fingerprint of the field's statistics.
]

== Euler characteristic, Betti numbers, and Morse theory

The Euler characteristic is related to the *Betti numbers* $beta_k$ by
$ chi = sum_k (-1)^k beta_k, $
where $beta_0$ = number of connected components, $beta_1$ = number of independent
cycles (handles/tunnels in 3D), $beta_2$ = number of enclosed cavities. Morse
theory connects these numbers to the critical points of the field: each local
maximum contributes $+1$ to $chi$, each saddle contributes $-1$, and each local
minimum contributes $+1$ (in 2D). Sweeping the threshold means watching critical
points enter and exit the excursion set, and $chi(nu)$ records every topological
event along the way.

// ================================================================
= From a fixed body to a random field: excursion sets
// ================================================================

Everything so far described a fixed, given body. The bridge to cosmology is a
single idea: turn a _continuous field_ into a family of bodies by *thresholding* it.

Let $u(bold(x))$ be a field — the CMB temperature contrast $Delta T slash T$, the
matter density contrast $delta$, a dust intensity map. For a threshold $nu$ define
the *excursion set*:
$ Q_nu = {bold(x) : u(bold(x)) >= nu}. $ <eq-excursion>

#figure(
  canvas({
    import draw: *
    let W = 13.0
    let H = 5.5
    let xmin = 0.0; let xmax = 10.0
    let ymin = -2.8; let ymax = 2.8
    let cx = (x) => x / xmax * W
    let cy = (y) => (y - ymin) / (ymax - ymin) * H

    // field as single-line arithmetic to avoid join errors
    let fy(x) = 1.2 * calc.sin(0.9 * x * 2 * calc.pi / 10) + 0.75 * calc.sin(2.1 * x * 2 * calc.pi / 10 + 1.0) + 0.4 * calc.cos(3.3 * x * 2 * calc.pi / 10)
    let nu-high = 1.1
    let nu-low  = -0.5
    let n = 300

    // shade above thresholds using thin vertical lines
    for i in range(n + 1) {
      let x = xmin + i / n * (xmax - xmin)
      let y = fy(x)
      if y >= nu-high {
        line((cx(x), cy(nu-high)), (cx(x), cy(y)),
             stroke: (paint: col1.lighten(55%), thickness: 0.15pt))
      }
      if y >= nu-low {
        line((cx(x), cy(nu-low)), (cx(x), cy(y)),
             stroke: (paint: col4.lighten(60%), thickness: 0.15pt))
      }
    }

    // grid
    for yi in (-2, -1, 0, 1, 2) {
      line((0, cy(yi)), (W, cy(yi)), stroke: (paint: mgray, thickness: 0.3pt))
    }

    // axes
    line((0, cy(0)), (W + 0.3, cy(0)), stroke: 0.6pt)
    line((0, 0), (0, H + 0.3), stroke: 0.6pt, mark: (end: ">"))
    content((W + 0.5, cy(0)), text(size: 9pt)[pos.])
    content((0.3, H + 0.4), text(size: 9pt)[$u(x)$])

    // field curve (drawn on top)
    let field-pts = range(n + 1).map(i => {
      let x = xmin + i / n * (xmax - xmin)
      (cx(x), cy(fy(x)))
    })
    line(..field-pts, stroke: col1 + 2pt)

    // threshold lines
    line((0, cy(nu-high)), (W, cy(nu-high)),
         stroke: (paint: acc, thickness: 1.5pt, dash: "dashed"))
    line((0, cy(nu-low)),  (W, cy(nu-low)),
         stroke: (paint: col4, thickness: 1.5pt, dash: "dashed"))

    // labels
    content((W + 0.05, cy(nu-high) + 0.2),
            text(size: 9pt, fill: acc)[$nu_1$], anchor: "west")
    content((W + 0.05, cy(nu-low) - 0.2),
            text(size: 9pt, fill: col4)[$nu_2$], anchor: "west")
    content((2.5, cy(1.9)), text(size: 8pt, fill: col1.darken(30%))[above $nu_1$: isolated islands])
    content((7.5, cy(-1.6)), text(size: 8pt, fill: col4.darken(30%))[above $nu_2$: connected])
  }),
  caption: [
    The "flooding" picture in 1D. As the threshold (dashed lines) is lowered from
    $nu_1$ (orange-red) to $nu_2$ (green), the set of positions where the field
    exceeds the threshold grows from isolated islands to large connected regions.
    In 2D/3D the excursion set $Q_nu$ is a body whose Minkowski functionals we
    measure at every $nu$, producing curves $V_k(nu)$.
  ]
) <fig-excursion>

#ibox(title: "The landscape and the flood")[
  Picture $u(bold(x))$ as a mountain landscape and $nu$ as a rising water level.
  At very low $nu$ nearly everything is above water — $Q_nu$ is almost the whole map.
  As the water rises: first the valleys flood (holes in the dry land appear —
  topology changes!), then the land breaks into separate islands, and finally only the
  highest peaks remain. At _each_ water level, photograph the dry region and measure
  its $d+1$ Minkowski functionals. Sweeping $nu$ from $-infinity$ to $+infinity$ turns
  each functional into a _curve_ $V_k(nu)$.
]

The key structural point: $V_0$ depends only on the field's _values_ (the cumulative
one-point PDF), but $V_1, V_2, dots$ involve _gradients and curvatures_ of the field,
and therefore probe how neighbouring points are correlated — genuine spatial structure
invisible to the one-point distribution alone.

// ================================================================
= The Gaussian baseline and its Hermite structure
// ================================================================

This is the section that turns Minkowski functionals into a measurement. We derive
the exact Gaussian predictions from first principles, step by step.

== What is a Gaussian random field?

A *random field* $u(bold(x))$ attaches a random number to every spatial point. It
is *Gaussian* if every finite collection of values
$(u(bold(x)_1), dots, u(bold(x)_n))$ follows a multivariate Gaussian (normal)
distribution.

#ibox(title: "What 'Gaussian' buys you")[
  A multivariate Gaussian is entirely fixed by its mean and covariances. So a
  Gaussian field with zero mean is *completely determined* by its two-point
  correlation function
  $ xi(bold(x), bold(x)') = chevron.l u(bold(x)) u(bold(x)') chevron.r, $
  or equivalently by its Fourier transform, the *power spectrum* $P(k)$. There is
  nothing else to know: all higher-order correlations are forced by these two. This
  means a Gaussian field has *independent random Fourier phases* — there are no
  preferred patterns, no filaments, no clusters, beyond what random phase-mixing
  produces. Correlated phases are exactly what "non-Gaussianity" means, and they are
  exactly what the power spectrum cannot see but Minkowski functionals can.
]

== Spectral moments: the only numbers that can appear

Because a Gaussian field is fixed by $P(k)$, every ensemble-averaged MF value must
be expressible as an integral of $P(k)$. The relevant integrals are the *spectral
moments*:

$ sigma_n^2 = integral (d^d k)/((2 pi)^d) k^(2n) P(k). $ <eq-spectral-moments>

Only the first two enter the Gaussian MF predictions:
$
sigma_0^2 = chevron.l u^2 chevron.r quad &("variance of the field"), \
sigma_1^2 = chevron.l |nabla u|^2 chevron.r quad &("variance of the gradient").
$

#figure(
  canvas({
    import draw: *
    let W = 11.0; let H = 5.5
    let kmin = 0.02; let kmax = 6.0
    let Pmin = -0.15; let Pmax = 2.0
    let cx = (k) => (k - kmin) / (kmax - kmin) * W
    let cy = (p) => (p - Pmin) / (Pmax - Pmin) * H

    // Schematic power spectrum: P(k) = A * k^n * exp(-k^2/2)
    let Pk(k)    = 0.85 * k * calc.exp(-k * k / 2.8)
    let k2Pk(k)  = k * k * Pk(k)

    // background
    rect((0,0),(W,H), fill: lgray, stroke: none)
    for yi in (0.25, 0.5, 0.75, 1.0, 1.25) {
      line((0, cy(yi)), (W, cy(yi)),
           stroke: (paint: white, thickness: 0.5pt))
    }
    for ki in (1, 2, 3, 4, 5) {
      line((cx(ki), 0), (cx(ki), H),
           stroke: (paint: white, thickness: 0.5pt))
    }

    // shade area under P(k) = sigma_0^2 integral contribution
    let npts = 200
    let area-pk = range(npts + 1).map(i => {
      let k = kmin + i / npts * (kmax - kmin)
      (cx(k), cy(Pk(k)))
    })
    // shade k²P(k) first so P(k) fill sits visibly on top
    let area-k2pk = range(npts + 1).map(i => {
      let k = kmin + i / npts * (kmax - kmin)
      (cx(k), cy(k2Pk(k)))
    })
    fill(col3.lighten(65%).transparentize(30%)); stroke(none)
    line(..(((0, cy(0)),) + area-k2pk + ((W, cy(0)),)), close: true)

    // shade P(k) on top so both fills are distinguishable
    fill(col1.lighten(55%).transparentize(30%)); stroke(none)
    line(..(((0, cy(0)),) + area-pk + ((W, cy(0)),)), close: true)

    // curves — draw k²P(k) dashed first, then P(k) solid on top
    let k2pk-pts = range(npts + 1).map(i => {
      let k = kmin + i / npts * (kmax - kmin)
      (cx(k), cy(k2Pk(k)))
    })
    fill(none)
    line(..k2pk-pts, stroke: (paint: col3, thickness: 2pt, dash: "dashed"))
    let pk-pts = range(npts + 1).map(i => {
      let k = kmin + i / npts * (kmax - kmin)
      (cx(k), cy(Pk(k)))
    })
    fill(none)
    line(..pk-pts, stroke: col1 + 2pt)

    // axes
    line((0, cy(0)), (W + 0.4, cy(0)), stroke: 0.8pt, mark: (end: ">"))
    line((0, cy(0)), (0, H + 0.3),     stroke: 0.8pt, mark: (end: ">"))
    content((W + 0.7, cy(0)), text(size: 10pt)[$k$])
    content((0.3, H + 0.4), text(size: 9pt)[$P$])

    // tick marks
    for ki in (1, 2, 3, 4, 5) {
      line((cx(ki), cy(0) - 0.1), (cx(ki), cy(0) + 0.1), stroke: 0.6pt)
      content((cx(ki), cy(0) - 0.38), text(size: 8pt)[#ki])
    }
    for pi in (0.5, 1.0, 1.5) {
      line((-0.1, cy(pi)), (0.1, cy(pi)), stroke: 0.6pt)
      content((-0.35, cy(pi)), text(size: 8pt)[#pi])
    }

    // legend
    let lx = 7.2; let ly = H - 0.5
    line((lx, ly + 0.3), (lx + 0.7, ly + 0.3), stroke: col1 + 2pt)
    content((lx + 0.85, ly + 0.3), text(size: 9pt, fill: col1)[$P(k)$ — area $= sigma_0^2$], anchor: "west")
    line((lx, ly - 0.15), (lx + 0.7, ly - 0.15),
         stroke: (paint: col3, thickness: 2pt, dash: "dashed"))
    content((lx + 0.85, ly - 0.15), text(size: 9pt, fill: col3)[$k^2 P(k)$ — area $= sigma_1^2$], anchor: "west")
  }),
  caption: [
    Schematic power spectrum $P(k)$ (solid blue) and its $k^2$-weighted version
    $k^2 P(k)$ (dashed red). The area under $P(k)$ equals the field variance
    $sigma_0^2 = chevron.l u^2 chevron.r$; the area under $k^2 P(k)$ equals the gradient
    variance $sigma_1^2 = chevron.l |nabla u|^2 chevron.r$. These two numbers are the _only_
    integrals of $P(k)$ that enter the Gaussian MF predictions. The ratio
    $sigma_1 slash sigma_0$ has units of inverse length and sets the typical scale of
    structures in the field.
  ]
) <fig-power-spec>

#ibox(title: "Why a gradient brings one power of k")[
  In Fourier space, the derivative $partial_x$ becomes multiplication by $i k$. So
  $|nabla u|^2$ carries a factor of $k^2$ relative to $u^2$, which is why $sigma_1^2$
  has the $k^2$ weight and $sigma_0^2$ has none. The ratio $sigma_1 slash sigma_0$
  is a typical wavenumber (inverse coherence length): a field with power concentrated
  at high $k$ has many small-scale wiggles (large $sigma_1 slash sigma_0$), while a
  smooth, large-scale field has small $sigma_1 slash sigma_0$.
]

#pbox(title: "Spectral moments for the CMB on the sphere")[
  For a field expanded in spherical harmonics with angular power spectrum $C_ell$ and
  beam/pixel window $b_ell$, the spectral moments read
  $
  sigma_0^2 = 1/(4pi) sum_ell (2ell+1) b_ell^2 C_ell,
  quad quad
  sigma_1^2 = 1/(4pi) sum_ell (2ell+1) ell(ell+1) b_ell^2 C_ell,
  $
  because the spherical Laplacian has eigenvalue $-ell(ell+1)$, so
  $chevron.l |nabla u|^2 chevron.r$ picks up the factor $ell(ell+1)$ — the sphere's
  version of $k^2$. These are the only two numbers from $C_ell$ that the Gaussian
  Minkowski functionals require.
]

== The simplest functional from first principles: $V_0$

Recall $V_0(nu)$ is the _fraction of space_ where $u(bold(x)) >= nu$. For a
homogeneous field this equals the probability of a single point exceeding $nu$:
$ V_0(nu) = Pr[u(bold(x)) >= nu]. $

#derbox(title: "Derivation of V₀")[
  At a single point, $u$ is a Gaussian random variable with variance $sigma_0^2$:
  $
  V_0(nu) = integral_nu^infinity 1/(sqrt(2 pi) sigma_0) e^(-u^2 slash (2 sigma_0^2)) d u.
  $
  Substitute $t = u slash (sqrt(2) sigma_0)$, so $d u = sqrt(2) sigma_0 d t$ and
  the lower limit becomes $nu slash (sqrt(2) sigma_0)$:
  $
  V_0(nu) = 1/sqrt(pi) integral_(nu slash sqrt(2) sigma_0)^infinity e^(-t^2) d t
           = 1/2 "erfc"lr((nu / (sqrt(2) sigma_0))).
  $
  In rms units $nu -> nu slash sigma_0$: $V_0(nu) = 1/2 "erfc"(nu slash sqrt(2))$.
]

#figure(
  canvas({
    import draw: *
    let W = 11.0; let H = 5.2
    let xmin = -4.2; let xmax = 4.2
    let ymin = -0.05; let ymax = 1.1
    let cx = (x) => (x - xmin) / (xmax - xmin) * W
    let cy = (y) => (y - ymin) / (ymax - ymin) * H

    // background
    rect((0,0),(W,H), fill: lgray, stroke: none)
    for yi in (0.25, 0.5, 0.75, 1.0) {
      line((0, cy(yi)), (W, cy(yi)), stroke: white + 0.5pt)
    }
    for xi in (-4, -3, -2, -1, 0, 1, 2, 3, 4) {
      line((cx(xi), 0), (cx(xi), H), stroke: white + 0.5pt)
    }
    // curve
    let n = 250
    let pts = range(n + 1).map(i => {
      let x = xmin + i / n * (xmax - xmin)
      (cx(x), cy(v0f(x)))
    })
    // Fill full range — V₀ > 0 everywhere, so the area under the curve
    // correctly represents the excursion-set fraction at every threshold.
    fill(col1.lighten(68%).transparentize(30%)); stroke(none)
    line(..(((cx(xmin), cy(0)),) + pts + ((cx(xmax), cy(0)),)), close: true)
    fill(none)
    line(..pts, stroke: col1 + 2.2pt)

    // axes
    line((0, cy(0)), (W + 0.4, cy(0)), stroke: 0.8pt, mark: (end: ">"))
    line((cx(0), cy(0)), (cx(0), H + 0.35), stroke: 0.8pt, mark: (end: ">"))
    content((W + 0.7, cy(0)), text(size: 10pt)[$nu \/ sigma_0$])
    content((cx(0) + 0.2, H + 0.4), text(size: 9pt)[$V_0$])

    // ticks
    for xi in (-3, -2, -1, 1, 2, 3) {
      line((cx(xi), cy(0) - 0.1), (cx(xi), cy(0) + 0.1), stroke: 0.6pt)
      content((cx(xi), cy(0) - 0.38), text(size: 8pt)[$#xi$])
    }
    for yi in (0.25, 0.5, 0.75, 1.0) {
      line((cx(0) - 0.1, cy(yi)), (cx(0) + 0.1, cy(yi)), stroke: 0.6pt)
      content((cx(0) - 0.42, cy(yi)), text(size: 8pt)[#yi])
    }

    // annotations
    // midpoint
    line((cx(0), cy(0)), (cx(0), cy(0.5)),
         stroke: (paint: acc, thickness: 0.7pt, dash: "dashed"))
    line((cx(xmin), cy(0.5)), (cx(0), cy(0.5)),
         stroke: (paint: acc, thickness: 0.7pt, dash: "dashed"))
    circle((cx(0), cy(0.5)), radius: 0.1, fill: acc, stroke: none)
    content((cx(-2.5), cy(0.5) + 0.25), text(size: 9pt, fill: acc)[half at $nu=0$])

    // formula — erfc closed form + integral definition
    content((cx(2.5), cy(0.88)),
            text(size: 10pt)[$V_0 = frac(1,2) "erfc"(nu \/ sqrt(2))$])
    content((cx(2.5), cy(0.68)),
            text(size: 9pt)[$= integral_nu^infinity frac(e^(-u^2 slash 2), sqrt(2pi)) d u$])
  }),
  caption: [
    The Gaussian prediction for $V_0(nu) = 1/2 "erfc"(nu slash sqrt(2))$: the fraction
    of the map above threshold. At the mean ($nu = 0$) exactly half the field is above,
    consistent with a symmetric distribution. This curve is simply the cumulative
    one-point distribution and carries no information about spatial correlations.
  ]
) <fig-v0>

== The boundary term $V_1$: level crossings and Rice's formula

$V_1$ measures the total length of the iso-contours $\{u = nu\}$ per unit area. To
derive its shape, we first ask a one-dimensional question: how often does a 1D
Gaussian process cross the level $nu$?

#figure(
  canvas({
    import draw: *
    let W = 11.0; let H = 5.0
    let xmin = 0.0; let xmax = 10.0
    let ymin = -2.5; let ymax = 2.8
    let cx = (x) => x / xmax * W
    let cy = (y) => (y - ymin) / (ymax - ymin) * H

    // single-line arithmetic to avoid join errors
    let fy(x) = 1.5 * calc.sin(0.7 * x * 2 * calc.pi / 10) + 0.9 * calc.sin(2.3 * x * 2 * calc.pi / 10 + 0.5) + 0.5 * calc.cos(3.8 * x * 2 * calc.pi / 10 + 1.2)
    let nu-val = 0.7
    let n = 300

    // background
    rect((0,0),(W,H), fill: lgray, stroke: none)

    // shade above threshold with thin vertical lines
    for i in range(n + 1) {
      let x = xmin + i / n * xmax
      let y = fy(x)
      if y >= nu-val {
        line((cx(x), cy(nu-val)), (cx(x), cy(y)),
             stroke: (paint: col1.lighten(55%), thickness: 0.15pt))
      }
    }

    // grid
    for xi in (2, 4, 6, 8) {
      line((cx(xi), 0), (cx(xi), H), stroke: white + 0.4pt)
    }
    for yi in (-2, -1, 0, 1, 2) {
      line((0, cy(yi)), (W, cy(yi)), stroke: white + 0.4pt)
    }

    // field curve
    let fpts = range(n + 1).map(i => {
      let x = xmin + i / n * xmax
      (cx(x), cy(fy(x)))
    })
    line(..fpts, stroke: col1 + 2pt)

    // threshold line
    line((0, cy(nu-val)), (W, cy(nu-val)),
         stroke: (paint: acc, thickness: 1.5pt, dash: "dashed"))
    content((W + 0.05, cy(nu-val)), text(size: 9pt, fill: acc)[$nu$], anchor: "west")

    // mark up-crossings functionally (no mutable array)
    let crossings = range(n).filter(i => {
      let x0 = xmin + i / n * xmax
      let x1 = xmin + (i + 1) / n * xmax
      fy(x0) < nu-val and fy(x1) >= nu-val
    }).map(i => {
      let x0 = xmin + i / n * xmax
      let x1 = xmin + (i + 1) / n * xmax
      let y0 = fy(x0); let y1 = fy(x1)
      x0 + (nu-val - y0) / (y1 - y0) * (x1 - x0)
    })
    for xc in crossings {
      circle((cx(xc), cy(nu-val)), radius: 0.18, fill: col4, stroke: none)
      line((cx(xc), cy(nu-val) - 0.45), (cx(xc), cy(nu-val) + 0.45),
           stroke: col4 + 0.9pt, mark: (end: ">"))
    }

    // axes
    line((0, cy(0)), (W + 0.3, cy(0)), stroke: 0.6pt)
    line((0, 0), (0, H + 0.2), stroke: 0.6pt, mark: (end: ">"))
    content((W + 0.5, cy(0)), text(size: 9pt)[$x$])
    content((0.25, H + 0.35), text(size: 9pt)[$u$])

    // legend
    circle((1.5, 0.42), radius: 0.18, fill: col4, stroke: none)
    content((1.8, 0.42), text(size: 8.5pt, fill: col4)[up-crossings of level $nu$], anchor: "west")
    content((5.0, cy(1.9)), text(size: 8pt, fill: col1.darken(20%))[above threshold], anchor: "west")
  }),
  caption: [
    Rice's level-crossing picture. Green dots mark *up-crossings* of the level $nu$
    (the field rises through $nu$). By Rice's formula, the expected rate of
    up-crossings per unit length is $N^+(nu) = frac(1,2pi) frac(sigma_1,sigma_0) e^(-nu^2/(2sigma_0^2))$,
    proportional to a Gaussian in $nu$. The contour length of the 2D excursion set
    follows the same threshold dependence via Crofton's formula.
  ]
) <fig-rice>

#derbox(title: "Rice's level-crossing formula")[
  Along a line, write the field as $X(t)$ with $chevron.l X^2 chevron.r = sigma_0^2$ and
  $chevron.l X'^2 chevron.r = sigma_1^2$. For a stationary Gaussian process the value
  $X$ and its derivative $X'$ at the _same_ point are _uncorrelated_ (hence, being
  jointly Gaussian, independent). An up-crossing at level $nu$ requires $X = nu$
  and $X' > 0$. The expected rate of up-crossings per unit length is:
  $
  N^+(nu) = integral_0^infinity X' p(X = nu, X') d X'
  = underbrace(p_X(nu))_("prob. near" nu) dot
    underbrace(integral_0^infinity X' p_(X')(X') d X')_(= sigma_1 slash sqrt(2pi)).
  $
  With $p_X(nu) = (1 slash (sqrt(2pi) sigma_0)) e^(-nu^2 slash (2sigma_0^2))$:
  $ N^+(nu) = 1/(2pi) sigma_1/sigma_0 e^(-nu^2 slash (2sigma_0^2)). $ <eq-rice>
  The contour length in 2D is proportional to this rate via Crofton's formula (averaging
  over all line orientations), so $V_1(nu) prop (sigma_1 slash sigma_0) e^(-nu^2 slash 2)$.
]

== The topology term $V_2$ (2D) and the genus $V_3$ (3D)

By Morse theory, the Euler characteristic of the excursion set counts the balance
of critical points above the threshold:
$ chi(Q_nu) = hash("maxima above" nu) - hash("saddles above" nu) + hash("minima above" nu). $

Sweeping $nu$ downward: first isolated peaks appear (adding $+1$ to $chi$ each time
a maximum enters), then saddle connections bridge them (adding $-1$), and finally
the deepest minima are reached. This competition produces the characteristic odd
shape (in 2D) or W-shape (in 3D) of the genus curve.

== The unifying identity: a ladder of derivatives

All of the above is a single statement in disguise. The *Hermite polynomials* are
generated by differentiating the Gaussian (Rodrigues' formula):
$ H_n(nu) e^(-nu^2 slash 2) = (-1)^n (d^n) / (d nu^n) e^(-nu^2 slash 2),
  quad quad H_0 = 1,quad H_1 = nu,quad H_2 = nu^2 - 1,quad H_3 = nu^3 - 3nu, dots $

The Minkowski functionals form a _ladder of derivatives_:

#dbox(title: "The Hermite ladder")[
  $
  V_0(nu) &prop integral_nu^infinity e^(-t^2 slash 2) d t = "erfc" quad ("antiderivative"), \
  V_1(nu) &prop e^(-nu^2 slash 2) = H_0 e^(-nu^2 slash 2) quad ("zeroth derivative"), \
  V_2(nu) &prop -d / (d nu) e^(-nu^2 slash 2) = nu e^(-nu^2 slash 2) = H_1 e^(-nu^2 slash 2), \
  V_3(nu) &prop d^2 / (d nu^2) e^(-nu^2 slash 2) = (nu^2 - 1) e^(-nu^2 slash 2) = H_2 e^(-nu^2 slash 2).
  $
  The general compact formula for $k >= 1$ is:
  $ V_k(nu) prop lr((sigma_1/sigma_0))^k H_(k-1)(nu) e^(-nu^2 slash 2). $ <eq-vk>
]

#ibox(title: "The whole structure in one sentence")[
  _Each higher Minkowski functional differentiates the Gaussian weight one more time_
  — and differentiating $e^{-nu^2/2}$ is precisely what generates the next Hermite
  polynomial. The amplitude gains one factor of $sigma_1 slash sigma_0$ at each rung
  (one more derivative of the _field_ is needed, which costs one power of $k$ in
  Fourier space), while the threshold shape climbs the Hermite ladder.
]

#pbox(title: "The Gaussian Kinematic Formula")[
  This ladder is not a coincidence of low dimensions. The *Gaussian Kinematic Formula*
  (Adler & Taylor) states that the expected Minkowski functionals of the excursion set
  factor as
  $
  chevron.l V_k(Q_nu) chevron.r
  = sum_j ["geometry of the survey region"]_(k,j)
    times [H_(j-1)(nu) e^(-nu^2 slash 2)],
  $
  i.e. a purely geometric prefactor (built from $sigma_1 slash sigma_0$ and the
  dimensions of the domain) times the universal Hermite $times$ Gaussian threshold
  functions. Tomita (1986) derived the explicit 2D/3D cases that practitioners use.
]

== Exact formulas collected

We collect the explicit Gaussian predictions (rms units $nu -> nu slash sigma_0$;
conventional prefactors from Schmalzing & Buchert 1997).

#dbox(title: "Two-dimensional Gaussian predictions (e.g. a CMB map)")[
  $
  V_0(nu) &= 1/2 "erfc"lr((nu/sqrt(2))), \
  V_1(nu) &= 1/8 sigma_1/sigma_0 e^(-nu^2 slash 2), \
  V_2(nu) &= 1/(2pi)^(3 slash 2) lr((sigma_1/sigma_0))^2 nu e^(-nu^2 slash 2).
  $
]

#pbox(title: "Three-dimensional Gaussian predictions (e.g. the galaxy density field)")[
  $
  V_0 &prop "erfc", \
  V_1 &prop sigma_1/sigma_0 e^(-nu^2 slash 2), \
  V_2 &prop lr((sigma_1/sigma_0))^2 nu e^(-nu^2 slash 2), \
  V_3 &prop lr((sigma_1/sigma_0))^3 (nu^2 - 1) e^(-nu^2 slash 2).
  $
]

== Individual plots of the Gaussian shapes

#figure(
  canvas({
    import draw: *
    // 2×2 grid of plots
    let pw = 5.8; let ph = 3.5   // panel width/height
    let gx = 0.8; let gy = 0.8  // gap between panels

    // helper: draw one panel
    // fill-to: x-coord where fill stops (defaults to xmax = 4.0)
    let panel(ox, oy, f, ymin, ymax, col, title-str, formula-str, fill-to: 4.0) = {
      let n = 200
      let xmin = -4.0; let xmax = 4.0
      let lx = (x) => ox + (x - xmin) / (xmax - xmin) * pw
      let ly = (y) => oy + (y - ymin) / (ymax - ymin) * ph

      // background
      rect((ox, oy), (ox + pw, oy + ph), fill: lgray, stroke: gray + 0.3pt, radius: 1.5pt)
      // grid
      for xi in (-3, -2, -1, 0, 1, 2, 3) {
        line((lx(xi), oy), (lx(xi), oy + ph), stroke: white + 0.4pt)
      }
      for yi in (0,) {
        line((ox, ly(0)), (ox + pw, ly(0)), stroke: white + 0.7pt)
      }

      // filled area — only up to fill-to (so erfc tail is not shaded)
      let pts-fill = range(n + 1).map(i => {
        let x = xmin + i / n * (fill-to - xmin)
        (lx(x), ly(calc.max(ymin * 0.98, calc.min(ymax * 0.98, f(x)))))
      })
      let base-fill = range(n + 1).map(i => {
        let x = xmin + i / n * (fill-to - xmin)
        (lx(x), ly(0))
      })
      fill(col.lighten(68%).transparentize(30%)); stroke(none)
      line(..(pts-fill + base-fill.rev()), close: true)

      // curve — full range regardless of fill-to
      let pts = range(n + 1).map(i => {
        let x = xmin + i / n * (xmax - xmin)
        (lx(x), ly(calc.max(ymin * 0.98, calc.min(ymax * 0.98, f(x)))))
      })
      fill(none)
      line(..pts, stroke: col + 2pt)

      // axes
      line((ox, ly(0)), (ox + pw + 0.25, ly(0)), stroke: 0.6pt, mark: (end: ">"))
      line((lx(0), oy), (lx(0), oy + ph + 0.2), stroke: 0.6pt, mark: (end: ">"))
      content((ox + pw + 0.45, ly(0)), text(size: 8pt)[$nu$])

      // title
      content((ox + pw / 2, oy + ph + 0.35),
              text(size: 9pt, fill: col, weight: "bold")[#title-str], anchor: "south")
      content((ox + pw / 2, oy + 0.25),
              text(size: 8pt, fill: col)[#formula-str], anchor: "south")

      // selected ticks
      for xi in (-2, 2) {
        line((lx(xi), ly(0) - 0.08), (lx(xi), ly(0) + 0.08), stroke: 0.5pt)
        content((lx(xi), ly(0) - 0.3), text(size: 7.5pt)[$#xi$])
      }
    }

    // ── V0 ────────────────────────────────────────────────
    panel(0, 5.1, v0f, -0.02, 1.1, col1, [$V_0(nu) = 1/2 "erfc"(nu slash sqrt(2))$], [area fraction])

    // ── V1 ────────────────────────────────────────────────
    panel(pw + gx, 5.1, v1f, -0.02, 1.1, col2, [$V_1(nu) prop e^(-nu^2 slash 2)$], [contour length])

    // ── V2 ────────────────────────────────────────────────
    panel(0, 0, v2f, -0.68, 0.68, col3, [$V_2(nu) prop nu e^(-nu^2 slash 2)$], [2D Euler char])

    // ── V3 ────────────────────────────────────────────────
    panel(pw + gx, 0, v3f, -1.05, 0.52, col4, [$V_3(nu) prop (nu^2-1) e^(-nu^2 slash 2)$], [3D genus])
  }),
  caption: [
    The four Gaussian threshold shapes. *Top-left:* $V_0$ — the erfc curve, falling
    monotonically from 1 to 0. *Top-right:* $V_1$ — a Gaussian bump peaked at the
    median threshold; the most boundary length occurs where the field is near its
    mean value. *Bottom-left:* $V_2$ — an odd function (antisymmetric); positive at
    high thresholds (many isolated hot islands), zero at $nu = 0$, negative at low
    thresholds (one big region with many cold holes). *Bottom-right:* $V_3$ — an even
    function (the 3D genus); dips to $-1$ at $nu = 0$ (the sponge phase) and recovers
    to positive in both tails (isolated pieces). Zeros of $V_3$ occur at $nu = plus.minus 1 sigma$.
  ]
) <fig-four-vk>

== Combined Hermite shapes

#figure(
  canvas({
    import draw: *
    let W = 12.0; let H = 5.8
    let xmin = -4.2; let xmax = 4.2
    let ymin = -1.1; let ymax = 1.15
    let cx = (x) => (x - xmin) / (xmax - xmin) * W
    let cy = (y) => (y - ymin) / (ymax - ymin) * H
    let n = 300

    // background
    rect((0,0),(W,H), fill: lgray, stroke: none)
    // grid
    for xi in (-4, -3, -2, -1, 0, 1, 2, 3, 4) {
      line((cx(xi), 0), (cx(xi), H),
           stroke: (paint: white, thickness: if xi == 0 { 1.0pt } else { 0.4pt }))
    }
    for yi in (-1.0, -0.5, 0.5, 1.0) {
      line((0, cy(yi)), (W, cy(yi)),
           stroke: (paint: white, thickness: if yi == 0 { 0.8pt } else { 0.4pt }))
    }

    // V1 = H0 * G  (blue)
    let p1 = range(n + 1).map(i => { let x = xmin + i / n *(xmax - xmin); (cx(x), cy(v1f(x))) })
    line(..p1, stroke: col1 + 2.2pt)

    // V2 = H1 * G  (orange)
    let p2 = range(n + 1).map(i => { let x = xmin + i / n *(xmax - xmin); (cx(x), cy(v2f(x))) })
    line(..p2, stroke: col2 + 2.2pt)

    // V3 = H2 * G  (crimson) — clipped to ymin
    let p3 = range(n + 1).map(i => {
      let x = xmin + i / n *(xmax - xmin)
      let y = calc.max(ymin + 0.01, v3f(x))
      (cx(x), cy(y))
    })
    line(..p3, stroke: (paint: col3, thickness: 2.2pt, dash: "dashed"))

    // axes
    line((0, cy(0)), (W + 0.4, cy(0)), stroke: 0.9pt, mark: (end: ">"))
    line((cx(0), 0), (cx(0), H + 0.4), stroke: 0.9pt, mark: (end: ">"))
    content((W + 0.7, cy(0)), text(size: 10pt)[$nu$])

    // ticks
    for xi in (-3, -2, -1, 1, 2, 3) {
      line((cx(xi), cy(0) - 0.1), (cx(xi), cy(0) + 0.1), stroke: 0.6pt)
      content((cx(xi), cy(0) - 0.38), text(size: 8.5pt)[$#xi$])
    }
    // ±1σ dotted verticals
    for xi in (-1, 1) {
      line((cx(xi), 0), (cx(xi), H),
           stroke: (paint: gray, thickness: 0.5pt, dash: "dotted"))
    }
    content((cx(1) + 0.1, 0.25), text(size: 8pt, fill: gray)[$+1sigma$])
    content((cx(-1) - 0.1, 0.25), text(size: 8pt, fill: gray)[$-1sigma$], anchor: "east")

    // legend
    let lx = 8.5; let base = H - 0.5
    line((lx, base + 0.25), (lx + 0.9, base + 0.25), stroke: col1 + 2.2pt)
    content((lx + 1.0, base + 0.25),
            text(size: 9pt, fill: col1)[$V_1 prop H_0 e^{-nu^2/2}$ (contour length)], anchor: "west")
    line((lx, base - 0.25), (lx + 0.9, base - 0.25), stroke: col2 + 2.2pt)
    content((lx + 1.0, base - 0.25),
            text(size: 9pt, fill: col2)[$V_2 prop H_1 e^{-nu^2/2}$ (2D Euler)], anchor: "west")
    line((lx, base - 0.75), (lx + 0.9, base - 0.75),
         stroke: (paint: col3, thickness: 2.2pt, dash: "dashed"))
    content((lx + 1.0, base - 0.75),
            text(size: 9pt, fill: col3)[$V_3 prop H_2 e^{-nu^2/2}$ (3D genus)], anchor: "west")
  }),
  caption: [
    The universal Gaussian threshold shapes $H_{k-1}(nu) e^(-nu^2 slash 2)$ for the
    three non-trivial functionals. *Every* Gaussian random field gives exactly these
    shapes, differing only in the amplitude $(sigma_1 slash sigma_0)^k$. The contour
    length peaks at the median; the 2D Euler characteristic is odd (crossing zero at
    $nu = 0$); the 3D genus is even (crossing zero at $nu = plus.minus 1 sigma$,
    dotted lines) with its distinctive W-shape dipping to $-1$ in the sponge regime.
    Departures from these shapes are the morphological signature of non-Gaussianity.
  ]
) <fig-hermite>

// ================================================================
= The cosmological payoff: measuring non-Gaussianity
// ================================================================

#pbox(title: "Why Minkowski functionals earn their place in cosmology")[
  *1. An exact, almost parameter-free null test.* The Gaussian curves derived above
  are predicted _exactly_ (not in some approximation), with only the amplitude
  $sigma_1 slash sigma_0$ to be fitted from data. Any departure of the measured
  $V_k(nu)$ from the Hermite $times$ Gaussian shapes is a model-independent flag of
  non-Gaussianity — whether primordial (inflationary $f_"NL"$), from nonlinear
  gravitational evolution, or from residual foregrounds.

  *2. Information the power spectrum is blind to.* The angular power spectrum $C_ell$
  captures _only_ the two-point function — it is identical for a true Gaussian field
  and for any field with the same spectrum but scrambled Fourier phases. Minkowski
  functionals are built from the geometry of iso-contours and are sensitive to *phase
  correlations*, hence to the entire hierarchy of higher-order connected correlations.
  They are genuinely complementary, not redundant with the power spectrum.

  *3. A morphological foreground diagnostic.* A cleaned CMB map should satisfy the
  Gaussian MF predictions; Galactic dust and other foregrounds are markedly non-Gaussian
  and distort them in characteristic ways, providing a powerful test of component
  separation pipelines.

  *4. Computationally cheap and robust.* Additivity (M2) means MFs can be computed
  by simple local algorithms on HEALPix maps — accumulate cell by cell — and are
  comparatively stable against noise compared with high-order $n$-point estimators.
]

== The Matsubara expansion for non-Gaussianity

Matsubara (2003, 2010) computed the leading non-Gaussian corrections perturbatively.
Defining _skewness parameters_ that capture the relevant three-point statistics:
$
S^{(0)} &= frac(chevron.l u^3 chevron.r, sigma_0^4), quad
S^{(1)} = frac(chevron.l u^2 nabla^2 u chevron.r, sigma_0^2 sigma_1^2), quad
S^{(2)} = frac(chevron.l (nabla u)^2 nabla^2 u chevron.r, sigma_1^4),
$
the corrected functionals take the form
$ V_k(nu) = V_k^"G"(nu) lr([1 + sigma_0 (a_k S^{(0)} + b_k S^{(1)} + c_k S^{(2)})])
  + cal(O)(sigma_0^2), $ <eq-ng-corr>
where $a_k, b_k, c_k$ are known Hermite coefficients. For primordial non-Gaussianity,
$S^{(a)} prop f_"NL"$, so fitting @eq-ng-corr to the data yields a direct constraint
on $f_"NL"$.

== Non-Gaussian deviation plot

#figure(
  canvas({
    import draw: *
    let W = 12.0; let H = 5.5
    let xmin = -4.2; let xmax = 4.2
    let ymin = -0.75; let ymax = 0.75
    let cx = (x) => (x - xmin) / (xmax - xmin) * W
    let cy = (y) => (y - ymin) / (ymax - ymin) * H
    let n = 300

    // background
    rect((0,0),(W,H), fill: lgray, stroke: none)
    for xi in (-4,-3,-2,-1,0,1,2,3,4) { line((cx(xi),0),(cx(xi),H), stroke: white + 0.4pt) }
    line((0, cy(0)), (W, cy(0)), stroke: white + 0.8pt)
    for yi in (-0.5, 0.5) { line((0,cy(yi)),(W,cy(yi)), stroke: white + 0.4pt) }

    // Gaussian V2
    let p-g = range(n + 1).map(i => { let x = xmin+i / n *(xmax - xmin); (cx(x), cy(v2f(x))) })
    line(..p-g, stroke: col1 + 2pt)

    // non-Gaussian: V2 with positive f_NL skews the curve (schematic shift)
    // positive skewness → shifts the Euler char curve to the right and adds H2 correction
    let fnl-pos = 0.3   // schematic amplitude
    let p-pos = range(n + 1).map(i => {
      let x = xmin + i / n * (xmax - xmin)
      let ng = v2f(x) + fnl-pos * (x*x - 1.0) * G(x) * 0.5
      (cx(x), cy(calc.max(ymin + 0.01, calc.min(ymax - 0.01, ng))))
    })
    line(..p-pos, stroke: (paint: col3, thickness: 2pt, dash: "dashed"))

    // non-Gaussian: negative f_NL
    let p-neg = range(n + 1).map(i => {
      let x = xmin + i / n * (xmax - xmin)
      let ng = v2f(x) - fnl-pos * (x*x - 1.0) * G(x) * 0.5
      (cx(x), cy(calc.max(ymin + 0.01, calc.min(ymax - 0.01, ng))))
    })
    line(..p-neg, stroke: (paint: col4, thickness: 2pt, dash: "dashed"))

    // shade deviation region (between Gaussian and pos f_NL)
    let pts-upper = p-pos
    let pts-lower = p-g.rev()
    fill(col3.lighten(80%)); stroke(none)
    line(..(pts-upper + pts-lower), close: true)

    // axes
    line((0, cy(0)), (W + 0.4, cy(0)), stroke: 0.9pt, mark: (end: ">"))
    line((cx(0), 0), (cx(0), H + 0.35), stroke: 0.9pt, mark: (end: ">"))
    content((W + 0.6, cy(0)), text(size: 10pt)[$nu$])

    // ticks
    for xi in (-3,-2,-1,1,2,3) {
      line((cx(xi), cy(0)-0.1),(cx(xi), cy(0)+0.1), stroke: 0.6pt)
      content((cx(xi), cy(0)-0.38), text(size: 8.5pt)[$#xi$])
    }

    // legend
    let lx = 0.3; let base = H - 0.4
    let y0 = base; let y1 = base - 0.5; let y2 = base - 1.0
    let x2 = lx + 0.9; let x3 = lx + 1.0
    line((lx, y0),(x2, y0), stroke: col1 + 2pt)
    content((x3, y0), text(size: 9pt, fill: col1)[Gaussian ($f_"NL" = 0$)], anchor: "west")
    line((lx, y1),(x2, y1), stroke: (paint: col3, thickness: 2pt, dash: "dashed"))
    content((x3, y1), text(size: 9pt, fill: col3)[$f_"NL" > 0$ (positive skew)], anchor: "west")
    line((lx, y2),(x2, y2), stroke: (paint: col4, thickness: 2pt, dash: "dashed"))
    content((x3, y2), text(size: 9pt, fill: col4)[$f_"NL" < 0$ (negative skew)], anchor: "west")

    // annotation of deviation region
    content((cx(2.5), cy(0.35)), text(size: 8.5pt, fill: col3)[NG deviation $prop f_"NL" sigma_0$])
  }),
  caption: [
    Schematic non-Gaussian deviations in $V_2(nu)$ (the 2D Euler characteristic).
    The solid blue curve is the exact Gaussian prediction $nu e^{-nu^2 slash 2}$.
    Dashed curves show the leading-order correction from @eq-ng-corr: positive
    $f_"NL"$ (red) skews the curve, shifting the zero-crossing and altering the
    amplitude asymmetrically; negative $f_"NL"$ (green) inverts the deviation. The
    shaded region marks the deviation band. Because the Gaussian shape is predicted
    _exactly_, any systematic departure is an unambiguous morphological detection of
    non-Gaussianity — independent of the power spectrum.
  ]
) <fig-ng-deviation>

== The primordial bispectrum

=== From power spectrum to three-point function

The power spectrum $P(k)$ is the Fourier-space two-point function:
$
chevron.l delta(bold(k)_1) delta(bold(k)_2) chevron.r = (2pi)^3 delta_D(bold(k)_1 + bold(k)_2) P(k_1).
$
For a _Gaussian_ field this is the end of the story: all odd moments vanish and all
even moments factorise into products of $P(k)$. Non-Gaussianity first appears in the
connected three-point function — the _bispectrum_ $B$:
$
chevron.l delta(bold(k)_1) delta(bold(k)_2) delta(bold(k)_3) chevron.r_c
  = (2pi)^3 delta_D(bold(k)_1 + bold(k)_2 + bold(k)_3) , B(k_1,k_2,k_3).
$
Translational invariance forces the Dirac delta: the three wavevectors must sum to
zero, $bold(k)_1 + bold(k)_2 + bold(k)_3 = bold(0)$, so they always form a
*closed triangle* in $k$-space. Rotational invariance then means $B$ depends only
on the three side-lengths $(k_1, k_2, k_3)$, not on the orientation of the triangle.

The ratio $B slash P^2$ has dimensions of inverse volume and measures the
_fractional non-Gaussianity_ of the field. A dimensionless amplitude $f_"NL"$ is
defined so that $B tilde.op f_"NL" P^2$; its precise definition depends on the
triangle configuration, as different inflationary mechanisms weight different triangle
shapes differently.

=== The triangle condition: why shape matters

Because $bold(k)_1 + bold(k)_2 + bold(k)_3 = bold(0)$, the bispectrum lives on a
two-dimensional surface in $(k_1, k_2, k_3)$ space — the space of valid triangles.
Its shape encodes the physical process that created the non-Gaussianity:

#figure(
  table(
    columns: (1.4fr, 1.4fr, 1.6fr, 1.8fr),
    stroke: none,
    fill: (x, y) => if y == 0 { def-bg } else if calc.even(y) { lgray } else { none },
    align: (left, center, center, left),
    [*Triangle type*], [*Configuration*], [*Peak condition*], [*Physical origin*],
    [Squeezed], [1 long + 2 short sides], [$k_1 lt.double k_2 approx k_3$],
      [Multi-field inflation; superhorizon mode modulates small-scale power],
    [Equilateral], [All sides equal], [$k_1 approx k_2 approx k_3$],
      [Non-standard kinetic term; all three modes leave the horizon together],
    [Folded (flattened)], [Two sides nearly sum to third], [$k_1 + k_2 approx k_3$],
      [Non-Bunch-Davies initial state; resonance at the triangle boundary],
  ),
  caption: [Triangle configurations of the primordial bispectrum and their inflationary origin.]
)

=== The three standard primordial shapes

*Local shape.* In multi-field inflation or curvaton scenarios the primordial
curvature perturbation receives a local (point-by-point in real space) quadratic
correction:
$
Phi(bold(x)) = phi_G(bold(x)) + f_"NL"^"loc" [phi_G^2(bold(x)) - chevron.l phi_G^2 chevron.r],
$ <eq-local-ansatz>
where $phi_G$ is a Gaussian field. Taking the Fourier transform of $Phi^3$ and
evaluating the connected correlator yields
$
B^"loc"(k_1,k_2,k_3) = 2 f_"NL"^"loc" [P(k_1)P(k_2) + P(k_2)P(k_3) + P(k_3)P(k_1)].
$
This is largest in the _squeezed_ limit $k_1 -> 0$: a superhorizon mode ($k_1 -> 0$)
modulates the local amplitude of small-scale fluctuations ($k_2 approx k_3$),
imprinting a correlation between large- and small-scale structure. Single-field
slow-roll inflation predicts $f_"NL"^"loc" approx 0.01$ (Maldacena 2003), so any
measured $f_"NL"^"loc" gt.double 1$ would rule out single-field inflation.

*Equilateral shape.* Models with a non-standard kinetic term ($k$-inflation, DBI
inflation) generate interactions proportional to $dot(phi)^3$ or $(nabla phi)^2 dot(phi)$.
These interactions are most efficient when all three modes exit the Hubble horizon
simultaneously, i.e., at $k_1 approx k_2 approx k_3$. The resulting bispectrum is
(Creminelli et al. 2006):
$
B^"equi"(k_1,k_2,k_3) = 6 f_"NL"^"equi" {
  &-[P(k_1)P(k_2) + "cyc."] \
  &quad - 2[P(k_1)P(k_2)P(k_3)]^(2/3) \
  &quad + [P(k_1)^(1/3)P(k_2)^(2/3)P(k_3) + "cyc."]}.
$
The leading minus sign ensures the signal vanishes in the squeezed limit (consistent
with the single-field consistency relation) while peaking at equilateral configurations.

*Folded (flattened) shape.* If the initial quantum state of the inflaton is not the
Bunch-Davies vacuum — for example, if the mode functions were excited before Hubble
exit — the bispectrum is enhanced when two momenta are nearly collinear,
$k_1 + k_2 approx k_3$:
$
B^"fold"(k_1,k_2,k_3) = 6 f_"NL"^"fold" {
  &+[P(k_1)P(k_2) + "cyc."] \
  &quad + 3[P(k_1)P(k_2)P(k_3)]^(2/3) \
  &quad - [P(k_1)^(1/3)P(k_2)^(2/3)P(k_3) + "cyc."]}.
$
This shape is orthogonal (in the Fisher-matrix sense) to both local and equilateral,
and its detection would point to non-standard pre-inflationary physics.

=== How the skewness parameters project the bispectrum

The three skewness parameters defined in @eq-ng-corr are not independent measurements
of $B$: they are specific _weighted integrals_ over all triangle configurations,
differing only in the power of $k$ used as a weight:
$
S^{(0)} &prop integral d^3k_1 d^3k_2 ; W(k_1 R) W(k_2 R) W(k_3 R) ; B(k_1,k_2,k_3), \
S^{(1)} &prop integral d^3k_1 d^3k_2 ; W(k_1 R) W(k_2 R) W(k_3 R) ; k_3^2 ; B(k_1,k_2,k_3), \
S^{(2)} &prop integral d^3k_1 d^3k_2 ; W(k_1 R) W(k_2 R) W(k_3 R) ; (bold(k)_1 dot bold(k)_2) k_3^2 ; B(k_1,k_2,k_3),
$
where $bold(k)_3 = -(bold(k)_1 + bold(k)_2)$ closes the triangle and $W(k R)$ is the
smoothing window. Each additional power of $k^2$ shifts sensitivity toward smaller
scales:

- $S^{(0)}$ weighs all triangles equally (up to the smoothing window); it is
  dominated by the overall amplitude of $B$.
- $S^{(1)}$ down-weights large-scale squeezed configurations (small $k_3$) and
  up-weights small-scale modes; it probes the bispectrum at intermediate triangle
  shapes.
- $S^{(2)}$ carries a dot product $bold(k)_1 dot bold(k)_2$ that further selects
  triangles where the two short sides make a large angle, suppressing squeezed
  triangles yet more.

Because local, equilateral, and folded bispectra peak at different triangle shapes,
the three parameters $S^{(0)}, S^{(1)}, S^{(2)}$ receive these signals in different
ratios. This means MF measurements of all three functionals together carry strictly
more information than any single projection of $B$, allowing the _shape_ of
non-Gaussianity — not just its amplitude — to be constrained.

=== Gravitational instability: the dominant non-Gaussian background in LSS

Even if primordial fluctuations are perfectly Gaussian ($f_"NL" = 0$), nonlinear
gravitational clustering generates a bispectrum that grows with time. At second order
in perturbation theory, the density contrast acquires a quadratic correction
(Bernardeau et al. 2002):
$
delta^((2))(bold(k)) = integral frac(d^3 q, (2pi)^3) F_2(bold(q), bold(k)-bold(q)) ; delta^((1))(bold(q)) ; delta^((1))(bold(k)-bold(q)),
$
where the gravitational mode-coupling kernel is
$
F_2(bold(k)_1, bold(k)_2) = frac(5,7) + frac(1,2) hat(k)_1 dot hat(k)_2 lr((frac(k_1,k_2)+frac(k_2,k_1))) + frac(2,7)(hat(k)_1 dot hat(k)_2)^2.
$
The three terms have clear physical meanings: the $5/7$ term comes from the
compression of matter during gravitational collapse (density-density coupling); the
cross term encodes the tidal shear (velocity-density coupling); the $2/7$ term
comes from the anisotropic velocity field (velocity-velocity coupling). This produces
a gravitational bispectrum
$
B_delta^"grav"(bold(k)_1, bold(k)_2, bold(k)_3) = 2 F_2(bold(k)_1,bold(k)_2)P(k_1)P(k_2) + "cyc."
$
with leading skewness values (for a scale-invariant $P(k) prop k^{-3}$ spectrum):
$
S^{(0)} approx frac(34,7), quad S^{(1)} approx frac(41,28), quad S^{(2)} approx frac(81,35).
$
For a typical smoothing scale $R = 10 h^{-1}"Mpc"$ and $sigma_0 approx 0.3$, the
fractional non-Gaussianity from gravity is $delta_"grav" tilde.op S^{(0)} sigma_0 approx 1.5$
— _two orders of magnitude larger_ than the primordial signal from $f_"NL" tilde.op 20$
(which gives $delta_"prim" tilde.op f_"NL" sigma_0^2 approx 0.018$). Placing constraints on
$f_"NL"$ from large-scale structure therefore requires subtracting the theoretically
predicted gravitational bispectrum before fitting for the residual.

=== Skew-spectra: retaining momentum dependence

The one-point parameters $S^{(j)}$ compress the full triangle-space distribution of
$B$ into a single number. A richer statistic — the _skew-spectrum_ $S^{(j)}(k_2)$
introduced by Pratten & Munshi (2012) — retains the dependence on one external
momentum:
$
S^{(j)}(k_2, R) = frac(1, sigma_0^(2+2j)) integral_0^infinity frac(k_1^2 d k_1, 2pi^2) W(k_1 R) W(k_2 R) integral_{-1}^{1} d mu ; k_2^(2j) ; B_delta(bold(k)_1, bold(k)_2, bold(k)_3).
$
Integrating $S^{(j)}(k_2,R)$ over $k_2$ with the appropriate weight $k_2^2 W(k_2 R) slash (2pi^2 sigma_0^2)$ recovers the one-point $S^{(j)}$. The $k_2$-dependence encodes _which scales_ contribute most to the skewness signal:

- For local non-Gaussianity $S^{(0)}(k_2)$ peaks at small $k_2$ (squeezed contribution
  from large scales), while $S^{(1)}(k_2)$ and $S^{(2)}(k_2)$ peak at intermediate
  $k_2$ because the $k_3^2$ weight suppresses small-$k$ contributions.
- For equilateral non-Gaussianity all three skew-spectra peak at the same
  $k_2 tilde.op R^{-1}$ (set by the smoothing scale), because the signal is
  concentrated at $k_1 approx k_2 approx k_3$.
- Gravitational instability generates a skew-spectrum with a characteristic _rising_
  shape at small $k_2$ that is qualitatively different from either primordial model,
  making it possible — in principle — to separate primordial from gravitational
  non-Gaussianity even without explicit PT subtraction, by comparing the measured
  $S^{(j)}(k_2)$ shape against templates.

== Topology vs threshold: the genus curve journey

#figure(
  canvas({
    import draw: *
    let W = 12.0; let H = 4.5
    let xmin = -4.0; let xmax = 4.0
    let ymin = -1.1; let ymax = 0.55
    let cx = (x) => (x - xmin) / (xmax - xmin) * W
    let cy = (y) => (y - ymin) / (ymax - ymin) * H
    let n = 300

    // background
    rect((0,0),(W,H), fill: lgray, stroke: none)
    for xi in (-4,-3,-2,-1,0,1,2,3,4) {
      line((cx(xi),0),(cx(xi),H), stroke: white + 0.4pt)
    }
    line((0,cy(0)),(W,cy(0)), stroke: white + 0.8pt)

    // fill negative region (sponge phase)
    let neg-pts = range(n + 1).map(i => {
      let x = xmin + i / n *(xmax - xmin)
      let y = calc.max(ymin + 0.01, v3f(x))
      (cx(x), cy(y))
    })
    let zero-line = range(n + 1).map(i => {
      let x = xmin + i / n *(xmax - xmin)
      (cx(x), cy(0))
    })
    // shade region where V3 < 0 (between ±1σ)
    fill(col3.lighten(80%)); stroke(none)
    let neg-lower = range(n + 1).map(i => {
      let x = xmin + i / n *(xmax - xmin)
      let y = v3f(x)
      (cx(x), cy(calc.max(ymin+0.01, calc.min(0.0, y))))
    })
    let zero-rev = range(n + 1).map(i => {
      let x = xmax - i / n *(xmax - xmin)
      (cx(x), cy(0))
    })
    line(..(neg-lower + zero-rev), close: true)

    // positive region
    fill(col4.lighten(80%)); stroke(none)
    let pos-upper = range(n + 1).map(i => {
      let x = xmin + i / n *(xmax - xmin)
      let y = v3f(x)
      (cx(x), cy(calc.min(ymax - 0.01, calc.max(0.0, y))))
    })
    line(..(pos-upper + zero-rev), close: true)

    // curve
    line(..neg-pts, stroke: col5 + 2.2pt)

    // axes
    line((0,cy(0)),(W+0.4,cy(0)), stroke: 0.9pt, mark: (end: ">"))
    line((cx(0),0),(cx(0),H+0.3), stroke: 0.9pt, mark: (end: ">"))
    content((W+0.7,cy(0)), text(size: 10pt)[$nu$])

    // ticks
    for xi in (-3,-2,-1,1,2,3) {
      line((cx(xi),cy(0)-0.1),(cx(xi),cy(0)+0.1), stroke: 0.6pt)
      content((cx(xi),cy(0)-0.38), text(size: 8.5pt)[$#xi$])
    }
    for yi in (-1.0, -0.5, 0.5) {
      line((cx(0)-0.1, cy(yi)),(cx(0)+0.1,cy(yi)), stroke: 0.6pt)
      content((cx(0)-0.4, cy(yi)), text(size: 8pt)[#yi])
    }

    // zero crossings
    for xi in (-1, 1) {
      line((cx(xi),0),(cx(xi),H), stroke: (paint: gray, thickness: 0.5pt, dash: "dotted"))
      circle((cx(xi), cy(0)), radius: 0.13, fill: col5, stroke: none)
    }

    // phase labels
    content((cx(-3.0), cy(0.3)),
            text(size: 9pt, fill: col4.darken(20%))[*isolated* \ *voids*], anchor: "center")
    content((cx(0.0), cy(-0.6)),
            text(size: 9pt, fill: col3.darken(20%))[*sponge phase* \ $chi < 0$], anchor: "center")
    content((cx(3.0), cy(0.3)),
            text(size: 9pt, fill: col4.darken(20%))[*isolated* \ *clusters*], anchor: "center")

    // arrow labels
    content((cx(-2.5), cy(-0.2)), text(size: 8pt, fill: gray)[low $nu$])
    content((cx(2.5), cy(-0.2)), text(size: 8pt, fill: gray)[high $nu$])
  }),
  caption: [
    The 3D genus curve $V_3(nu) prop (nu^2 - 1) e^(-nu^2 slash 2)$ annotated with
    the three topological phases. At high $nu$ (right tail): only isolated clusters
    survive, so $chi > 0$. For $|nu| < 1 sigma$ (shaded red region): the above-threshold
    region is a multiply-connected sponge with more handles than components, so $chi < 0$.
    At low $nu$ (left tail): isolated underdense voids appear in an otherwise filled space —
    again separate pieces, so $chi > 0$. The zeros at $nu = plus.minus 1 sigma$ (purple
    dots) are the topological phase boundaries, universally predicted for any Gaussian field.
  ]
) <fig-genus-curve>

// ================================================================
= The CMB as a worked example
// ================================================================

The cosmic microwave background (CMB) temperature map is the ideal testing ground
for Minkowski functionals: it is close to Gaussian, it is two-dimensional (the
celestial sphere), and its statistical properties are predicted by inflation with
remarkable precision. Walking through the CMB case from first principles illustrates
every concept developed above.

== The CMB field and its excursion sets

Let $u(hat(n))$ denote the fractional temperature contrast
$delta T slash T$ at sky position $hat(n)$. After smoothing to a beam scale
$theta_s$ (e.g., the Planck $5'$ beam), this field has:

$
sigma_0^2 = sum_ell (2ell+1)/(4pi) C_ell W_ell^2, quad
sigma_1^2 = sum_ell (2ell+1)/(4pi) C_ell W_ell^2 dot ell(ell+1),
$

where $C_ell$ is the angular power spectrum and $W_ell = e^{-ell^2 theta_s^2 / 2}$
is the Gaussian beam window. For the Planck 2018 best-fit spectrum smoothed to
$theta_s approx 20'$, one finds roughly $sigma_0 approx 70 mu"K"$ and the effective
multipole $ell_"eff" = sigma_1 / sigma_0 approx 100$–$200$ depending on the smoothing
scale.

The excursion set at threshold $nu$ is simply the "hot-spot region":
$Q_nu = { hat(n) : u(hat(n)) >= nu sigma_0 }.$
As $nu$ increases from $-infinity$ to $+infinity$, the hot-spot region shrinks from
the whole sky to a set of isolated points.

== What each Minkowski functional measures on a CMB map

The two-dimensional Gaussian predictions (see @eq-vk and the explicit 2D formulas collected earlier) read:

$
V_0(nu) &= 1/2 "erfc"(nu/sqrt(2)), \
V_1(nu) &= 1/(4sqrt(2)) sigma_1/sigma_0 e^{-nu^2/2}, \
V_2(nu) &= 1/(2pi) (sigma_1/sigma_0)^2 nu e^{-nu^2/2}.
$

Each carries a clean physical meaning for the CMB:

*$V_0$ — area fraction.* The fraction of the sky hotter than $nu sigma_0$. At
$nu = 0$ this is exactly $1 slash 2$ by symmetry: half the sky is above the mean.
At $nu = 2$ (two sigma above average), $V_0 approx 2.3%$ of the sky is in "hot
spots." This is the simplest Gaussian null test: compute the area fraction of your
map at a grid of thresholds and check it follows the erfc curve.

*$V_1$ — total contour length.* The total length of the $nu sigma_0$ temperature
contour on the sphere, per unit sky area. At $nu = 0$ this is the total length of
the hot-cold boundary — the "cosmic equator" of the temperature field. At high $|nu|$
the contours are rare and short; the curve peaks at $nu = 0$ and falls symmetrically
on both sides. Any asymmetry between the $nu > 0$ and $nu < 0$ sides is a signal of
non-Gaussianity or a systematic.

*$V_2$ — genus / Euler characteristic.* The number of connected hot-spot regions
minus the number of holes in those regions, per unit sky area. For the CMB, the
topological journey as $nu$ increases is:
- Low $nu$ (very cold threshold): almost the entire sky is "above threshold," and
  only isolated cold voids poke through. The genus $chi > 0$.
- $nu approx -1 sigma_0$: topology reversal; the hot region becomes multiply connected.
  $chi < 0$ (sponge phase).
- $nu approx 0$: the zero-crossing of the genus curve; the hot-spot topology is
  changing.
- High $nu$: only isolated hot spots survive. $chi > 0$ again.
The zero-crossings at $nu = plus.minus sigma_0$ are a universal Gaussian prediction,
independent of the power spectrum amplitude.

#exbox(title: "Worked numbers for a Planck-like map")[
  Take $sigma_0 = 75 mu"K"$, $sigma_1 / sigma_0 = 150 "rad"^{-1}$ (after 20 arcmin
  smoothing on the full sphere). At threshold $nu = 2$ (i.e., $150 mu"K"$):

  $V_0(2) = 1/2 "erfc"(2/sqrt(2)) approx 2.28%$ of the sky is in hot spots.

  $V_1(2) = 1/(4sqrt(2)) dot 150 dot e^{-2} approx 2.2 "rad"^{-1}$
  (total contour length per steradian).

  $V_2(2) = 1/(2pi) dot 150^2 dot 2 dot e^{-2} approx 2640 "rad"^{-2}$
  (genus density, in units of per steradian).

  These are the _exact_ Gaussian predictions: if the measured values deviate, the
  field is non-Gaussian. For $nu = -2$ the values of $V_0$ and $V_1$ are symmetric,
  but $V_2(-2) = -V_2(2)$ — a sign flip that reflects the cold-spot topology.
]

== Numerical computation of MFs on pixelised maps

In practice the CMB temperature field is available as a pixelised HEALPix map
$(u_i)_{i=1}^{N_"pix"}$. Schmalzing & Górski (1998) established the standard
pixel estimators. For a uniformly weighted map the three 2D MFs are approximated by
$
V_0(nu) approx frac(1,N_"pix") sum_i Theta(u_i - nu), \
V_1(nu) approx frac(1,N_"pix") sum_i frac(delta_Delta(u_i - nu),4) |bold(nabla) u_i|, \
V_2(nu) approx frac(1,N_"pix") sum_i frac(delta_Delta(u_i - nu),2pi) kappa(bold(x)_i) |bold(nabla) u_i|,
$
where the Dirac delta is replaced by the top-hat approximation
$delta_Delta(x) approx [Theta(x + Delta/2) - Theta(x - Delta/2)] slash Delta$,
and $kappa$ is the geodesic curvature of the level contour at pixel $i$.

On the sphere the gradient and curvature require _covariant_ derivatives. In
spherical coordinates $(theta, phi)$ (colatitude $theta$, longitude $phi$):
$
u_{;theta} = frac(1,sin theta) u_{,theta}, quad
u_{;phi} = u_{,phi}, quad
u_{;theta theta} = frac(1,sin^2 theta) u_{,theta theta} + frac(cos theta,sin theta) u_{,phi},
$
with the geodesic curvature of the excursion-set boundary then:
$
kappa = frac(2 u_{;theta} u_{;phi} u_{;theta phi} - u_{;theta}^2 u_{;phi phi} - u_{;phi}^2 u_{;theta theta}, (u_{;theta}^2 + u_{;phi}^2)^{3/2}).
$

#exbox(title: "Binning residuals and the optimal threshold step (Lim & Simon 2012)")[
  A finite bin width $Delta$ introduces a _systematic residual_ in $V_1$ and $V_2$
  that scales as $(Delta)^2 slash sigma_0$. To leading order:
  $
  R_1^Delta(nu) approx frac(Delta^2,24 sigma_0^2) partial_(nu)^2 bar(V)_1^G(nu) + cal(O)(Delta^4),
  $
  and analogously for $V_2$. These residuals are _not_ caused by pixelisation or
  masking — they are a pure finite-difference artefact. Lim & Simon (2012) derived
  the residual-free estimator by computing $V_1$ and $V_2$ via an analytic integral
  over each bin rather than a midpoint evaluation.

  Numerically, the optimal single-map bin width at HEALPix $N_"side" = 512$ is
  $Delta slash sqrt(sigma_0) approx 0.9$; at $N_"side" = 2048$ (Planck resolution)
  one can afford $Delta slash sqrt(sigma_0) approx 0.31$--$0.46$ while keeping
  residuals below the pixel-noise floor.
]

#ibox(title: "Sensitivity to disk-like CMB features (Lim & Simon 2012)")[
  A circular disk of radius $theta_D$ with uniform temperature offset $delta T$
  superimposed on a Gaussian background shifts the MFs by
  $Delta V_i(nu) approx (A slash 4pi) partial_mu bar(V)_i^G(nu; mu + delta T, sigma)$,
  where $A = 2pi(1 - cos theta_D)$ is the disk solid angle. For a single
  realization, the intrinsic CMB variance smears this signal by
  $tilde.op (sqrt(sigma_0) partial_nu)^3 bar(V)_i^G$, so detection requires either
  $delta T slash sqrt(sigma_0) gt.double 1$ or averaging over many sky realizations.
  Application to WMAP 7-year data yielded no statistically significant disk signal,
  consistent with a purely Gaussian CMB.
]

// ================================================================
= What the power spectrum misses
// ================================================================

The power spectrum $C_ell$ is the variance of the Fourier (spherical harmonic)
amplitudes $a_{ell m}$. It encodes *how much* power there is at each angular scale,
but says nothing about *how that power is arranged in space* — specifically, nothing
about the phases of the $a_{ell m}$ coefficients.

== Phase information: a concrete thought experiment

Construct two CMB-like maps:
- *Map A*: a genuine Gaussian realisation of the Planck best-fit $C_ell$.
  Its spherical harmonic phases $phi_{ell m} = arg(a_{ell m})$ are independent
  random variables, uniformly distributed on $[0, 2pi)$.
- *Map B*: take a non-Gaussian realisation (e.g., from a lognormal model or a
  simulation with $f_"NL" = 50$), measure its $|a_{ell m}|$, and _replace_ the
  phases with those from Map A. The result has the same $C_ell$ as Map B (since
  $C_ell prop chevron.l |a_{ell m}|^2 chevron.r$) but Gaussian-scrambled phases.

By construction, the power spectra of Maps A and B are identical. A measurement of
$C_ell$ alone cannot distinguish them. But the MFs immediately reveal the difference:
Map B has excess clustering of hot spots — the connected regions are larger and fewer
at high $nu$, the genus curve deviates from the Hermite $times$ Gaussian template,
and the zero-crossings shift. Minkowski functionals are built from the _geometry_
of the excursion set and are therefore sensitive to the phases of all harmonic
coefficients simultaneously.

#ibox(title: "Why MFs and power spectra are complementary, not competing")[
  The power spectrum captures all information in a Gaussian field (by definition: a
  Gaussian field _is_ fully specified by its two-point function). For a non-Gaussian
  field, the power spectrum remains a valid and useful statistic — it just does not
  capture the additional information encoded in phase correlations. Minkowski
  functionals access precisely this extra information: they are sensitive to the full
  hierarchy of connected correlations (bispectrum, trispectrum, …), but they compress
  that information into three scalar curves rather than a high-dimensional tensor. This
  makes them both computationally tractable and robust to noise.
]

// ================================================================
= How non-Gaussianity shifts the MF curves
// ================================================================

== Effect of $f_"NL"$ on the MF curves

The local ansatz @eq-local-ansatz shows that $f_"NL"$ controls the skewness of the
one-point PDF. Its effect on the three Minkowski functional curves is:
- $f_"NL" > 0$: the distribution is positively skewed — rare high-threshold regions
  are enhanced. The genus curve $V_2(nu)$ shifts to larger $nu$ (hot spots appear
  at higher threshold), and $V_0(nu)$ departs from the erfc shape at large $nu$.
- $f_"NL" < 0$: the distribution is negatively skewed — overdense peaks are
  suppressed; underdense troughs are enhanced relative to Gaussian.
- $f_"NL" = 0$: exact Gaussian. All three functionals follow the Hermite $times$ Gaussian
  templates exactly.

These shifts are captured by @eq-ng-corr with $S^{(a)} prop f_"NL"$ for the local
shape; different primordial shapes (equilateral, folded) give different ratios
$S^{(0)} : S^{(1)} : S^{(2)}$, as described in the preceding section.

== Size of the effect on the CMB

The fractional correction to $V_2(nu)$ from $f_"NL"$ is of order
$f_"NL" sigma_0$. For the CMB, $sigma_0 approx 10^{-3}$ in dimensionless units (or
$approx 70 mu"K"$ in absolute units), so even $f_"NL" approx 100$ gives only a $approx 10%$
correction. Detecting a $f_"NL" approx 10$ signal is therefore at the $approx 1%$ level —
well within reach of high signal-to-noise full-sky maps but below the noise floor of
ground-based surveys.

#exbox(title: "Order of magnitude: f_NL effect on the genus curve")[
  For the CMB with $sigma_0 approx 10^{-3}$, the fractional correction to $V_2$ from
  local $f_"NL"$ at the peak of the genus curve ($nu approx 1$) is:
  $
  Delta V_2 / V_2 approx f_"NL" dot sigma_0 dot c_2 approx f_"NL" times 10^{-3},
  $
  where $c_2$ is an $cal(O)(1)$ Hermite coefficient. For $f_"NL" = 10$ this is a
  $1%$ effect. The Planck team measures the genus curve to better than this precision
  over much of the sky, hence the constraint $|f_"NL"^"local"| lt.tilde 10$.
]

== Current observational constraints

The table below summarises representative MF-based non-Gaussianity constraints
from CMB observations. All results are consistent with $f_"NL" = 0$ at the quoted
significance.

#figure(
  table(
    columns: (2.2fr, 2fr, 1.6fr),
    stroke: none,
    align: (left, center, left),
    fill: (x, y) => if y == 0 { rgb("#EAF3FB") } else if calc.even(y) { lgray } else { none },
    [*Statistic / dataset*], [*Constraint (approx.)*], [*Reference*],
    [$V_2(nu)$ genus curve, WMAP 9-yr], [$|f_"NL"^"local"| lt.tilde 30$],
      [Hikage et al. 2008],
    [Combined $V_0,V_1,V_2$, Planck 2018], [Consistent Gaussian at $2sigma$],
      [Planck Collab. 2020],
    [$V_2$ + power spectrum, Planck 2018], [$f_"NL"^"local" = -0.9 plus.minus 5.1$],
      [Planck Collab. 2020],
    [MFs, large-scale structure], [$|f_"NL"| lt.tilde 50$ (galaxy surveys)],
      [e.g., Appleby et al. 2021],
  ),
  caption: [
    Representative MF-based constraints on primordial non-Gaussianity. The
    Planck constraints are roughly an order of magnitude tighter than WMAP thanks
    to lower noise, better beam characterisation, and more complete sky coverage.
  ]
) <tab-fnl-constraints>

The MF approach remains competitive with bispectrum estimators for local $f_"NL"$,
and has the advantage of directly testing the morphology of the temperature field
rather than relying on a specific model for the non-Gaussianity signal.

== MF-based likelihood analysis

For quantitative parameter inference one constructs a Gaussian likelihood over the
vector of measured MF values $bold(V) = {V_k(nu_j)}$ (Hamann & Kang 2023):
$
-2 ln cal(L)(bold(theta)) prop sum_{i,j} [V_i - V_i^"th"(bold(theta))] [bold(C)^{-1}]_{i j} [V_j - V_j^"th"(bold(theta))],
$
where $bold(C)$ is the covariance matrix estimated from $N_"sim"$ simulations and
$bold(theta)$ are the cosmological parameters of interest. To correct for the
_inverse-covariance bias_ in a finite simulation ensemble (Hartlap et al. 2007),
the inverse is rescaled:
$
bold(C)^{-1} -> frac(N_"sim" - p - 2, N_"sim" - 2) hat(bold(C))^{-1},
$
where $p$ is the total number of data points (e.g. $p = 3 times 11 = 33$ for three
MFs at 11 thresholds).

A key limitation of the one-scale approach is _parameter degeneracy_: many different
power spectra can share the same $sigma_0$ and $sigma_1$ and therefore predict the
same MF curves. Hamann & Kang (2023) resolve this via _needlet decomposition_:
the map is band-pass filtered into needlet coefficients $beta_j(hat(n))$ at scales
$j in {4,5,6,7,8,9}$ (covering multipoles $ell tilde.op 20$--$400$), and MFs are
computed independently at each scale. The per-scale MFs retain the full shape
information of $C_ell$ rather than just its $sigma_0$-weighted integral.

#exbox(title: "Application to Planck CMB weak lensing convergence (Hamann & Kang 2023)")[
  The CMB weak lensing convergence $kappa(hat(n))$ traces the projected matter
  distribution along the line of sight. Hamann & Kang (2023) applied MF analysis
  to the Planck 2018 lensing convergence map ($f_"sky" = 0.671$, multipoles
  $8 <= ell <= 400$, with iterative inpainting of masked regions) and obtained
  constraints on $Omega_m h^2$ and $A_s$ via the likelihood above with $N_"sim" = 10000$
  Planck FFP10 simulations.

  Key findings:
  - MF-inferred parameter constraints are _fully consistent_ with those from the
    standard lensing power spectrum, providing an independent morphological cross-check.
  - At current Planck noise levels, reconstruction noise dominates over the intrinsic
    non-Gaussianity of the convergence field at all needlet scales.
  - Once noise is removed (as in future surveys with CMB-S4 or Simons Observatory),
    the non-Gaussian morphological information in $kappa$ becomes accessible and
    the MF likelihood can yield tighter constraints than the power spectrum alone.
  - The analysis pipeline — inpainting, needlet filtering, MF computation,
    covariance from simulations, Hartlap correction — is publicly available at
    #link("https://github.com/Kang-Yuqi/MF_lensing")[github.com/Kang-Yuqi/MF_lensing].
]

// ================================================================
= One-page summary
// ================================================================

#dbox(title: "The whole story in eight lines")[
  + *Morphology* = coordinate-free description of size, shape, and connectivity.
  + Demand three properties of a shape number: _motion invariance, additivity, continuity_.
  + *Hadwiger (1957):* in $d$ dimensions, _exactly $d+1$_ such numbers exist — the
    Minkowski functionals. They form a *complete basis* for this class of descriptors.
  + *Steiner picture:* inflate the body by $epsilon$; the volume is a polynomial in
    $epsilon$ whose coefficients are the functionals.
  + *Curvature picture:* the functionals are integrals of $1$, surface element, mean
    curvature, and Gaussian curvature = *volume, surface, bending, topology* ($chi$ via
    Gauss–Bonnet).
  + *Excursion sets:* threshold a random field at level $nu$; measure the MFs of the
    region above $nu$; sweep $nu$ to obtain curves $V_k(nu)$.
  + *Gaussian baseline:* $V_k(nu) prop (sigma_1 slash sigma_0)^k H_{k-1}(nu) e^{-nu^2 slash 2}$
    — universal Hermite $times$ Gaussian shapes, exact and parameter-free.
  + *Payoff:* deviations from these shapes measure *non-Gaussianity* — phase
    correlations the power spectrum cannot see; also a diagnostic for foreground
    contamination and systematic effects.
]

== Guide to the literature

#table(
  columns: (1.2fr, 2.8fr),
  stroke: none,
  fill: (x, y) => if calc.even(y) { lgray } else { none },
  align: (right, left),
  [*Hadwiger (1957)*], [Completeness theorem for additive, motion-invariant, continuous functionals.],
  [*Gauss–Bonnet*], [Standard differential geometry; see e.g. do Carmo (1976).],
  [*Steiner (1840)*], [Original parallel-body formula; modern proofs in Schneider (2014).],
  [*Tomita (1986)*], [Gaussian MF formulae for 2D and 3D excursion sets.],
  [*Gott et al. (1986)*], [Introduction of the genus statistic in large-scale structure.],
  [*Mecke et al. (1994)*], [MFs as morphological statistics in condensed matter and cosmology.],
  [*Schmalzing & Buchert (1997)*], [Practical MF computation for 3D density fields; normalisation conventions used here.],
  [*Schmalzing & Górski (1998)*], [MFs on the sphere; HEALPix pixel estimators, covariant derivatives, and masking corrections for CMB maps.],
  [*Adler & Taylor (2007)*], [_Random Fields and Geometry_; the Gaussian Kinematic Formula.],
  [*Matsubara (2003, 2010)*], [Perturbative non-Gaussian corrections to all MFs; $f_"NL"$ constraints.],
  [*Lim & Simon (2012)*], [Binning residuals in numerical MF estimators; detectability of disk-like CMB features; WMAP7 null result.],
  [*Pratten & Munshi (2012)*], [Skew-spectra as momentum-dependent extension of skewness parameters; local, equilateral, folded bispectrum shapes; gravitational instability contribution in LSS.],
  [*Planck Collaboration*], [Current CMB MF measurements and non-Gaussianity limits.],
  [*Hamann & Kang (2023)*], [MF-based Gaussian likelihood for Planck lensing convergence; needlet decomposition; Hartlap bias correction; competitive $Omega_m h^2$, $A_s$ constraints.],
)
