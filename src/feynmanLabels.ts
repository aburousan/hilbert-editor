// What a label looks like on screen. The document gets the Typst as typed;
// this is so the canvas shows a photon as γ rather than as the word "gamma".
const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const SUPERS: Record<string, string> = { '-': '⁻', '+': '⁺', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', 'n': 'ⁿ', 'i': 'ⁱ', '*': '∗' };
const SUBS: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', 'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ' };
const script = (text: string, table: Record<string, string>) => {
  const out = [...text].map(ch => table[ch]);
  return out.every(Boolean) ? out.join('') : null;
};
export const prettyLabel = (raw: string): string => {
  // Quoted text is text: `"mu"` is the word, not the letter μ.
  const quoted: string[] = [];
  let text = raw.replace(/"([^"]*)"/g, (_, inner) => `\u0000${quoted.push(inner) - 1}\u0000`);
  // A bar over a letter, an italic aside, and the Greek names.
  text = text.replace(/\b(?:macron|overline|bar)\(([^()]*)\)/g, (_, inner) => `${inner}\u0304`);
  text = text.replace(/\b(?:italic|upright|bold)\(([^()]*)\)/g, '$1');
  const greek = (word: string) => GREEK[word] ?? word;
  // A word between anything that is not a letter or digit — an underscore
  // counts, so the ν in `nu_mu` is found as well as the μ.
  const WORD = /(?<![A-Za-z0-9])[A-Za-z]+(?![A-Za-z0-9])/g;
  text = text.replace(WORD, greek);
  // A script takes a braced group or one run of letters and digits — `x^2 + 1`
  // raises the 2 alone — and only becomes small characters when every one of
  // them exists; `nu_mu` stays as ν with μ beside it rather than nonsense.
  const scripted = (table: Record<string, string>, mark: string) => (_whole: string, braced: string, bare: string) => {
    const body = (braced ?? bare).replace(/(?<![A-Za-z0-9])[A-Za-z]+(?![A-Za-z0-9])/g, greek);
    return script(body, table) ?? `${mark}${body}`;
  };
  text = text.replace(/\^(?:\{([^{}]*)\}|([A-Za-z0-9]+|[-+*]))/g, scripted(SUPERS, '^'));
  text = text.replace(/_(?:\{([^{}]*)\}|([A-Za-z0-9]+|[-+]))/g, scripted(SUBS, '_'));
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => quoted[Number(i)]);
};
