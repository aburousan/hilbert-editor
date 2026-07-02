#import "@preview/mitex:0.2.7": mitex
#set page(paper: "a4")
#set text(font: "New Computer Modern", size: 11pt)

// Sections and equations are numbered by default:
#set heading(numbering: "1.")
#set math.equation(numbering: "(1)")

#import "@preview/cetz:0.3.4"
#import "@preview/physica:0.9.5": *

= Typst with Physics and CeTZ!

This is a local, offline editor for *Typst*. It comes pre-configured with packages!

```python
expand((x**2 - 1)**10)
```

#mitex(`x^{20} - 10 x^{18} + 45 x^{16} - 120 x^{14} + 210 x^{12} - 252 x^{10} + 210 x^{8} - 120 x^{6} + 45 x^{4} - 10 x^{2} + 1`)

