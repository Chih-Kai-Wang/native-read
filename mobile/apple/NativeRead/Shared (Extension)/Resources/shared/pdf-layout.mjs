/**
 * NativeRead — Pure PDF Geometric Layout, Math Preservation, Font Detection & Echo Guard Engine.
 * Zero DOM / chrome.* / pdfjsLib global dependencies so it runs identically in:
 * - Extension PDF.js Viewer (viewer/pdf-viewer.js)
 * - Mobile PWA PDF Reader (docs/pdf-layout.mjs via scripts/build-mobile.js)
 * - Node.js unit/regression tests (tests/pdf-layout.test.mjs)
 */

export const SERIF_FONT_REGEX = /serif|times|garamond|georgia|mincho|cambria|palatino|charter|merriweather|baskerville|book(?:man)?|roman|caslon|minion|nimbusrom|computer\s*modern|libertine|termes|pagella|schola|bonum|stix|xits|kpserif|newtx|txr|lmroman|cmr\d*|cmbx\d*|cmti\d*|cmsl\d*|cmcsc\d*|sfrm\d*|sfbx\d*|sfti\d*|sfsl\d*|sfcc\d*|ecrm\d*|ecbx\d*|ecti\d*|ecsl\d*|ptm|ppl|bch|utopia|fourier|antiqua/i;
export const SANS_FONT_REGEX = /(?:^|[\s,+_-])(?:sans(?!-serif)|arial|helvetica|calibri|roboto|inter|lato|open\s*sans|verdana|tahoma|gothic|cmss\d*|sfss\d*|ecss\d*|lmsans\d*|nimbus\s*sans|biolinum|heros|adventor|myriad|frutiger|avenir|futura|gill|segoe|cantarell|noto\s*sans|source\s*sans|ibm\s*plex\s*sans|fira\s*sans)/i;
export const MONO_FONT_REGEX = /mono|courier|consolas|menlo|code|cmtt\d*|sftt\d*|ectt\d*|lmmono\d*|inconsolata|fira\s*code|dejavusansmono|beramono|txtt/i;
export const BOLD_FONT_REGEX = /(?:^|[-_+,\s])(bold|black|heavy|semibold|demi|medi(?:um)?|extra|ultra|bx\d*|b\d{2}|sfbx\d*|ecbx\d*|cmbx\d*|nimbus.*medi)/i;
export const ITALIC_FONT_REGEX = /(?:^|[-_+,\s])(italic|oblique|slant|ti\d*|sl\d*|cmti\d*|cmsl\d*|sfti\d*|sfsl\d*|ecti\d*|ecsl\d*)/i;
export const MATH_FONT_REGEX = /(?:^|[\s+_-])(?:cmmi|cmsy|cmex|msam|msbm|xyatip|xybtip|eufm|eusm|rsfs|esint|stmary|wasy|txsy|txmi|txex|pxsy|pxmi|pxex|newtxmi|newtxsy|newtxex|lmex|lmsy|lmmi)\d*|\b(?:math|symbol|stix.*math|cambria\s*math|latinmodernmath)\b/i;

export const BULLET_PREFIX_REGEX = /^(?:[•●▪▸►‣⁃◦–—\-*]|(?:\(?\d{1,3}[.)])|(?:[a-zA-Z][.)]\s))(?:\s|$)/;
export const FOOTNOTE_PREFIX_REGEX = /^(?:[†‡§¶∗⋆]|[*]\s*(?:\d|[A-Z]))/;

const ACCENT_GLYPH_TO_COMBINING = {
  '˚': '\u030A',
  '°': '\u030A',
  '\u02DA': '\u030A',
  'ˆ': '\u0302',
  '˜': '\u0303',
  '¯': '\u0304',
  '˙': '\u0307',
  '¨': '\u0308'
};

export function defaultMultiplyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

export function defaultHashText(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (c + i) & 0xffff;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}_${s.length}`;
}

// ============================================================
// Math Classification, Placeholders & LaTeX Normalization
// ============================================================
export const PROSE_STOPWORD_SET = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'that', 'this', 'these', 'those', 'which', 'or', 'and', 'but', 'not',
  'we', 'our', 'they', 'their', 'it', 'its', 'can', 'may', 'will',
  'has', 'have', 'had', 'using', 'used', 'into', 'between', 'among',
  'above', 'below', 'each', 'all', 'both', 'such', 'figure', 'table',
  'section', 'also', 'more', 'most', 'only', 'than', 'then', 'when',
  'where', 'while', 'study', 'show', 'prove', 'obtain', 'determine'
]);

export const MATH_CONNECTOR_WORDS = new Set([
  'in', 'on', 'at', 'for', 'all', 'and', 'or', 'if', 'where', 'with', 'as',
  'to', 'of', 'by', 'from', 'when', 'otherwise', 'else', 'then', 'subject',
  'such', 'that', 'is', 'are', 'be', 'let', 'given', 'every', 'some', 'any'
]);

export const MATH_KEYWORD_SET = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh',
  'log', 'ln', 'exp', 'lim', 'sup', 'inf', 'max', 'min', 'argmax', 'argmin',
  'softmax', 'sigmoid', 'relu', 'gelu', 'det', 'dim', 'mod', 'diag', 'trace',
  'concat', 'attention', 'multihead', 'layernorm', 'sublayer', 'ffn', 'pe', 'pos'
]);

export function analyzeMathDensity(clean) {
  const explicitMathOps = (
    clean.match(/[=≈≠≤≥≡≢∼≃≅∝<>±×÷−·⋅∙∘⊗⊕∗∑∏∫∮√∞∂∇∈∉∋⊂⊃⊆⊇∪∩∀∃∧∨¬→←↔⇒⇐⇔↦^_{}\\|′″‖⟨⟩⌊⌋⌈⌉]/g) || []
  ).length;
  const relationOps = (clean.match(/[=≈≠≤≥≡∼∝∈∉⊂⊆→⇒⇔]/g) || []).length;
  const funcCallMatches = clean.match(/[A-Za-z_][A-Za-z0-9_]*[′']?\s*\(/g) || [];
  const funcCallTokens = funcCallMatches.length;
  const arithOps = (clean.match(/(?<=[A-Za-z0-9)\]}.′'])\s*[+\-−*/]\s*(?=[A-Za-z0-9(\[{√∑∫])/g) || []).length;

  const strippedWhere = clean.replace(/^where\s+(?=[A-Za-z_\u0391-\u03C9].*[=≈≤≥∈])/i, '');
  const rawTokens = strippedWhere.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  let connectorWords = 0;
  let narrativeWords = 0;
  for (const tok of rawTokens) {
    const low = tok.toLowerCase();
    if (MATH_CONNECTOR_WORDS.has(low)) {
      connectorWords += 1;
    } else if (PROSE_STOPWORD_SET.has(low)) {
      narrativeWords += 1;
    }
  }

  const withoutFuncNames = strippedWhere
    .replace(/[A-Za-z_][A-Za-z0-9_]*[′']?\s*\(/g, '(')
    .replace(/[A-Za-z][A-Za-z0-9_]*(?=[₀-₉ₐ-ₜᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓₕ⁰-⁹ⁱⁿ^_])/g, 'x');
  const candidateWords = withoutFuncNames.match(/[A-Za-z][A-Za-z0-9_]*/g) || [];
  let nonMathProseWords = 0;
  for (const w of candidateWords) {
    const low = w.toLowerCase();
    if (w.length <= 2) continue;
    if (w.includes('_')) continue;
    if (/[a-z][A-Z]/.test(w)) continue;
    if (/^[A-Z]{2,5}$/.test(w)) continue;
    if (PROSE_STOPWORD_SET.has(low) || MATH_CONNECTOR_WORDS.has(low) || MATH_KEYWORD_SET.has(low)) continue;
    nonMathProseWords += 1;
  }

  return {
    explicitMathOps,
    relationOps,
    funcCallTokens,
    arithOps,
    connectorWords,
    narrativeWords,
    nonMathProseWords,
    mathRatio: explicitMathOps / Math.max(1, clean.length)
  };
}

export function isDisplayedMathBlock(clean, meta = {}) {
  if (!clean) return false;
  if (meta.isHeading) return false;

  const stats = analyzeMathDensity(clean);
  const {
    explicitMathOps,
    relationOps,
    funcCallTokens,
    arithOps,
    connectorWords,
    narrativeWords,
    nonMathProseWords,
    mathRatio
  } = stats;

  // Never classify multi-word natural prose paragraphs as displayed equations
  if (nonMathProseWords >= 5 || narrativeWords >= 4) {
    return false;
  }

  const hasDisplayLayout = Boolean(
    meta.isCentered ||
    meta.endsWithEqNum ||
    (meta.mathFontRatio || 0) >= 0.35
  );
  const startsLikeProseSentence =
    /^(?:where|if|when|then|let|for|since|because|thus|hence|therefore|note|suppose|assume|here|in\s+contrast|furthermore|moreover|however|whereas)\b/i.test(clean);
  const endsWithSentencePeriod =
    /\.[)"'”’]?$/.test(clean) &&
    !/\b(?:etc|e\.g|i\.e|vs|fig|eq)\.$/.test(clean.toLowerCase());
  const inlineProseCues =
    !hasDisplayLayout &&
    (startsLikeProseSentence || endsWithSentencePeriod || nonMathProseWords >= 1 || narrativeWords >= 1);

  const wordsAll = clean.match(/[a-zA-Z\p{L}]{2,}/gu) || [];
  if (explicitMathOps >= 3 && mathRatio > 0.14 && nonMathProseWords <= 2 && wordsAll.length <= 6 && !inlineProseCues) {
    return true;
  }

  if (meta.endsWithEqNum && relationOps >= 1 && nonMathProseWords <= 4 && narrativeWords <= 1) {
    return true;
  }
  if (
    !inlineProseCues &&
    !(meta.isCentered && endsWithSentencePeriod && (nonMathProseWords > 0 || narrativeWords > 0)) &&
    !(startsLikeProseSentence && endsWithSentencePeriod && (meta.mathFontRatio || 0) < 0.35) &&
    relationOps >= 1 &&
    (explicitMathOps + funcCallTokens + arithOps) >= 2 &&
    nonMathProseWords <= 2 &&
    connectorWords <= 4 &&
    narrativeWords <= 1
  ) {
    return true;
  }
  if (
    !inlineProseCues &&
    !(startsLikeProseSentence && endsWithSentencePeriod && (meta.mathFontRatio || 0) < 0.35) &&
    (explicitMathOps + arithOps) >= 3 &&
    nonMathProseWords <= 1 &&
    connectorWords <= 2 &&
    narrativeWords === 0
  ) {
    return true;
  }
  if (
    (meta.mathFontRatio || 0) >= 0.40 &&
    nonMathProseWords <= 2 &&
    narrativeWords <= 1
  ) {
    return true;
  }
  if (
    meta.isCentered &&
    (meta.lineCount || 1) <= 4 &&
    (explicitMathOps + funcCallTokens) >= 2 &&
    nonMathProseWords <= 2 &&
    connectorWords <= 4 &&
    narrativeWords <= 1 &&
    !/[.?!]$/.test(clean)
  ) {
    return true;
  }
  return false;
}

export function isDisplayedMathLine(line, viewportWidth) {
  const clean = String(line?.text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  const w = Math.max(1, Number(viewportWidth) || 800);
  const lineCenter = ((line.x || 0) + (line.right || 0)) * 0.5;
  const lineIsCentered =
    Math.abs(lineCenter - w * 0.5) <= w * 0.12 &&
    (line.w || 0) < w * 0.62 &&
    (line.x || 0) > w * 0.16 &&
    w - (line.right || 0) > w * 0.16;
  const lineMathFontRatio = (line.mathFontWeight || 0) / Math.max(1, line.weight || 1);
  return isDisplayedMathBlock(clean, {
    isHeading: false,
    lineCount: 1,
    mathFontRatio: lineMathFontRatio,
    isCentered: lineIsCentered,
    endsWithEqNum: /\(\s*\d+(?:\.\d+)*[a-z]?\s*\)$/.test(clean)
  });
}

export function shouldTranslatePdfText(text, targetLangId, meta = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 4) return false;

  // Skip URLs, emails, DOIs, arXiv stamps
  if (/^(?:https?:\/\/|www\.|mailto:|ftp:\/\/)\S+$/i.test(clean)) return false;
  if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(clean)) return false;
  if (/^(?:doi:|arxiv:)\S+$/i.test(clean)) return false;

  // Skip pure numbers, equation tags, page numbers, table numbers, ratios, dates
  if (/^[\d\s.,:%+\-−–—/()[\]$€£¥°×÷±·⋅≈≠≤≥∞√∑∏∫∂∇∈∉⊂⊃∪∩∀∃→←↔⇒⇐⇔′″‖⟨⟩\u0370-\u03FF]+$/.test(clean)) return false;
  if (/^(?:\(\s*\d+(?:\.\d+)*[a-z]?\s*\)|\[\s*\d+(?:,\s*\d+)*\s*\])$/.test(clean)) return false;
  if (/^(?:page|p\.?|pp\.?)\s*\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(clean)) return false;
  if (/^\d+\s*\/\s*\d+$/.test(clean)) return false;
  if (/^(?:fig\.?|figure|table|tab\.?|eq\.?)\s*\d+[a-z]?\.?$/i.test(clean)) return false;

  const letters = clean.match(/\p{L}/gu) || [];
  if (letters.length < 2) return false;

  // Skip pure monospace code-like lines
  if (meta.isMono && /[=(){}[\];<>]|^\s*(?:def|class|import|from|return|const|let|var|for|while|if)\b/.test(clean)) {
    return false;
  }

  // Skip displayed equations / mathematical formulas
  if (isDisplayedMathBlock(clean, meta)) {
    return false;
  }

  const words = clean.match(/[a-zA-Z\p{L}]{2,}/gu) || [];

  // Skip single short isolated chart tick labels / tiny table cells (unless heading)
  if (
    !meta.isHeading &&
    meta.lineCount === 1 &&
    meta.widthRatio !== undefined &&
    meta.widthRatio < 0.14 &&
    words.length <= 2 &&
    clean.length < 16
  ) {
    return false;
  }

  // Skip text already written in target language
  const letterTotal = letters.length;
  const hanCount = (clean.match(/\p{Script=Han}/gu) || []).length;
  const kanaCount = (clean.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const hangulCount = (clean.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g) || []).length;
  const target = String(targetLangId || 'zh-TW');

  if (target === 'zh-TW' || target === 'zh-CN') {
    if (kanaCount / letterTotal >= 0.12) return true;
    if (hanCount / letterTotal >= 0.55) {
      const latinWords = clean.match(/[a-zA-Z]{2,}/g) || [];
      if (latinWords.length < 6) return false;
    }
  } else if (target === 'ja') {
    if ((kanaCount + hanCount) / letterTotal >= 0.55 && kanaCount >= 2) {
      return false;
    }
  } else if (target === 'ko') {
    if (hangulCount / letterTotal >= 0.5) {
      return false;
    }
  }

  return true;
}

export function isUntranslatedEcho(sourceText, translatedText, targetLangId = 'zh-TW') {
  const stripTokens = (s) =>
    String(s || '')
      .replace(/\[\[\s*\/?[CMLAS]\d*\s*\]\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const cleanSrc = stripTokens(sourceText);
  const cleanTrans = stripTokens(translatedText);
  if (!cleanSrc || !cleanTrans) return false;

  const srcLatinWords = cleanSrc.match(/[A-Za-z]{3,}/g) || [];
  if (srcLatinWords.length < 6) return false;

  const srcLowerProseWords = cleanSrc.match(/\b[a-z]{3,}\b/g) || [];
  if (srcLowerProseWords.length < 3) return false;

  const target = String(targetLangId || 'zh-TW');
  if (target === 'zh-TW' || target === 'zh-CN') {
    const hanCount = (cleanTrans.match(/\p{Script=Han}/gu) || []).length;
    if (hanCount === 0) return true;
    if (srcLatinWords.length >= 12 && hanCount < 3) return true;
    return false;
  }
  if (target === 'ja') {
    const jpCount = (cleanTrans.match(/[\p{Script=Han}\u3040-\u309f\u30a0-\u30ff]/gu) || []).length;
    if (srcLatinWords.length >= 8 && jpCount < 2) return true;
    return false;
  }
  if (target === 'ko') {
    const koCount = (cleanTrans.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/gu) || []).length;
    if (srcLatinWords.length >= 8 && koCount < 2) return true;
    return false;
  }

  if (srcLatinWords.length >= 10 && cleanTrans.toLowerCase() === cleanSrc.toLowerCase()) {
    return true;
  }
  return false;
}

export function isOverlayNoOp(sourceText, translatedText) {
  const norm = (s) =>
    String(s || '')
      .replace(/\[\[\s*\/?[CMLAS]\d*\s*\]\]/gi, '')
      .replace(/[∗⋆]/g, '*')
      .replace(/\s+/g, ' ')
      .replace(/^[\s*†‡§¶.,;:()[\]"'“”‘’]+|[\s*†‡§¶.,;:()[\]"'“”‘’]+$/g, '')
      .toLowerCase();

  const normSrc = norm(sourceText);
  const normTrans = norm(translatedText);
  return Boolean(normSrc && normTrans && normSrc === normTrans);
}

export function protectInlineMath(text) {
  const src = String(text || '');
  const placeholders = new Map();
  let seq = 0;
  const addToken = (match) => {
    const token = `[[M${seq++}]]`;
    placeholders.set(token, match);
    return token;
  };

  let out = src;

  // 1. Parenthesized sequences/tuples: (x_1 , ..., x_n ), (z_1 , ..., z_n ), (y_1, ..., y_m)
  out = out.replace(
    /\(\s*[A-Za-z\u0391-\u03C9](?:\s*_?\s*[0-9a-zA-Z])?\s*,\s*(?:\.\.\.|…)\s*,\s*[A-Za-z\u0391-\u03C9](?:\s*_?\s*[0-9a-zA-Z])?\s*\)/g,
    (m) => (m.includes('[[M') ? m : addToken(m))
  );

  // 2. Norm/operator equalities & inequalities: ||u||_∞ = L + 1/α, f ∈ C¹[0, ∞) ∩ C²(0, ∞), f⁽³⁾(0⁺) ≥ 3ηα²
  out = out.replace(
    /(?:[‖|]{1,2}[A-Za-z\u0391-\u03C9][^\s,;]*[‖|]{1,2}|(?:\d+(?:\.\d+)?|[A-Za-z\u0391-\u03C9])(?:[₀-₉⁰-⁹⁽⁾⁺⁻]+|_[A-Za-z0-9∞αβγδεζηθλμνξπρστυφχψω]+)?(?:\([^()]{1,24}\))?)\s*[=≈≠≤≥<>∈∉⊂⊆→]\s*(?:[^\s,;.]*(?:\([^()]{1,24}\)|\[[^\]]{1,24}\])?[^\s,;.]*)(?:\s*(?:[∩∪+\-−*/<>≤≥=]\s*(?:[^\s,;.]*(?:\([^()]{1,24}\)|\[[^\]]{1,24}\])?[^\s,;.]*)))*/g,
    (m) => {
      if (m.includes('[[M')) return m;
      const plainLongWords = m.replace(/\([^)]*\)|\[[^\]]*\]/g, '').match(/[A-Za-z]{4,}/g) || [];
      if (plainLongWords.length > 1) return m;
      return addToken(m.trim());
    }
  );

  // 3. Math function calls with math operators or 1-2 short variable arguments (supports 1 level of nested parens)
  out = out.replace(
    /\b[A-Za-z][A-Za-z0-9_]*[′']?\(((?:\([^()]{1,28}\)|[^()]){1,48})\)/g,
    (m, inner) => {
      if (m.includes('[[M')) return m;
      const hasMathOp = /[=+\-−*/^_<>|⁺⁻⁰-⁹₀-₉∞]/.test(inner);
      const isShortVarArgs = /^\s*[A-Za-z\u0391-\u03C9](?:\s*,\s*[A-Za-z\u0391-\u03C9])?\s*$/.test(inner);
      if (hasMathOp || isShortVarArgs) {
        return addToken(m);
      }
      return m;
    }
  );

  // 4. Compact inline assignments/relations missed by rule 2
  out = out.replace(
    /\b[A-Za-z\u0391-\u03C9](?:_[A-Za-z0-9]+|\s+[a-z]{1,6})?\s*[=≈≠≤≥∈⊂→]\s*(?:(?:−|-)?\d+(?:\.\d+)?|\[\[M\d+\]\]|\([^)]{1,32}\))/g,
    (m) => (m.includes('[[M') ? m : addToken(m))
  );

  return { text: out, placeholders };
}

export function restoreMathPlaceholders(text, placeholders) {
  let out = String(text || '');
  if (!placeholders || placeholders.size === 0) return out;
  for (let pass = 0; pass < 4; pass++) {
    const next = out.replace(/\[\[\s*M\s*(\d+)\s*\]\]/gi, (full, idx) => {
      const key = `[[M${idx}]]`;
      return placeholders.has(key) ? placeholders.get(key) : full;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

export const LATEX_BLACKBOARD_MAP = {
  R: 'ℝ', Z: 'ℤ', N: 'ℕ', C: 'ℂ', E: '𝔼', P: 'ℙ', Q: 'ℚ'
};

export const LATEX_SYMBOL_MAP = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  pm: '±', mp: '∓', div: '÷', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  otimes: '⊗', oplus: '⊕', leq: '≤', le: '≤', geq: '≥', ge: '≥',
  neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  ll: '≪', gg: '≫', in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃',
  subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩', forall: '∀', exists: '∃',
  neg: '¬', land: '∧', lor: '∨', to: '→', rightarrow: '→', leftarrow: '←',
  leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
  sum: '∑', prod: '∏', int: '∫', oint: '∮', infty: '∞', partial: '∂', nabla: '∇',
  emptyset: '∅', varnothing: '∅', angle: '∠', prime: '′', perp: '⊥', parallel: '∥',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉'
};

export const UNICODE_SUBSCRIPT_MAP = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ',
  n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ'
};

export const UNICODE_SUPERSCRIPT_MAP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  n: 'ⁿ', i: 'ⁱ', T: 'ᵀ', '*': '∗'
};

function readBraceGroup(str, openIdx) {
  if (str[openIdx] !== '{') return null;
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '{' && str[i - 1] !== '\\') depth += 1;
    else if (str[i] === '}' && str[i - 1] !== '\\') {
      depth -= 1;
      if (depth === 0) {
        return { content: str.slice(openIdx + 1, i), endIdx: i + 1 };
      }
    }
  }
  return null;
}

function replaceLatexMacroWithOneArg(str, macroRegex, transformFn) {
  let out = '';
  let pos = 0;
  macroRegex.lastIndex = 0;
  let match;
  while ((match = macroRegex.exec(str)) !== null) {
    const start = match.index;
    const afterCmd = start + match[0].length;
    let braceStart = afterCmd;
    while (braceStart < str.length && str[braceStart] === ' ') braceStart += 1;
    const grp = readBraceGroup(str, braceStart);
    if (!grp) continue;
    out += str.slice(pos, start) + transformFn(grp.content, match[1]);
    pos = grp.endIdx;
    macroRegex.lastIndex = pos;
  }
  return out + str.slice(pos);
}

function replaceLatexFrac(str) {
  const fracRe = /\\(?:d|t)?frac\b/g;
  let out = '';
  let pos = 0;
  let match;
  while ((match = fracRe.exec(str)) !== null) {
    const start = match.index;
    let idx = start + match[0].length;
    while (idx < str.length && str[idx] === ' ') idx += 1;
    const numGrp = readBraceGroup(str, idx);
    if (!numGrp) continue;
    idx = numGrp.endIdx;
    while (idx < str.length && str[idx] === ' ') idx += 1;
    const denGrp = readBraceGroup(str, idx);
    if (!denGrp) continue;
    const num = numGrp.content.trim();
    const den = denGrp.content.trim();
    const numFmt = /[+\-\s]/.test(num) && !/^\(.*\)$/.test(num) ? `(${num})` : num;
    const denFmt = /[+\-\s]/.test(den) && !/^\(.*\)$/.test(den) ? `(${den})` : den;
    out += str.slice(pos, start) + `${numFmt}/${denFmt}`;
    pos = denGrp.endIdx;
    fracRe.lastIndex = pos;
  }
  return out + str.slice(pos);
}

export function mapScriptChars(raw, mapObj, fallbackPrefix) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  let converted = '';
  for (const ch of trimmed) {
    if (!Object.prototype.hasOwnProperty.call(mapObj, ch)) {
      if (fallbackPrefix === '_' && /^[A-Za-z0-9]+$/.test(trimmed)) {
        return `_${trimmed}`;
      }
      if (/[\s→+\-=(),]/.test(trimmed)) {
        return `${fallbackPrefix}(${trimmed})`;
      }
      return `${fallbackPrefix}${trimmed}`;
    }
    converted += mapObj[ch];
  }
  return converted;
}

export function latexToUnicode(expr) {
  let s = String(expr || '').trim();
  if (!s) return '';

  s = s.replace(/\\(?:left|right|bigl?|Bigl?|biggl?|Biggl?|bigr?|Bigr?|biggr?|Biggr?)\b/g, '');
  s = s.replace(/\\(?:qquad|quad|,|;|!|:|\s)/g, ' ');

  s = replaceLatexMacroWithOneArg(s, /\\mathbb\b/g, (inner) => {
    const k = inner.trim();
    return LATEX_BLACKBOARD_MAP[k] || k;
  });

  const fontWrapperRe = /\\(?:text|mathrm|operatorname|mathbf|mathit|mathsf|mathtt|boldsymbol|bm|mathcal|mbox)\b/g;
  for (let pass = 0; pass < 3; pass++) {
    const next = replaceLatexMacroWithOneArg(s, fontWrapperRe, (inner) => inner);
    if (next === s) break;
    s = next;
  }

  for (let pass = 0; pass < 2; pass++) {
    s = replaceLatexFrac(s);
    s = replaceLatexMacroWithOneArg(s, /\\sqrt\b/g, (inner) => {
      const t = inner.trim();
      return t.length === 1 ? `√${t}` : `√(${t})`;
    });
  }
  s = replaceLatexMacroWithOneArg(s, /\\(hat|bar|tilde|vec|overline|mathring|ring)\b/g, (inner, cmd) => {
    const t = inner.trim();
    const comb =
      cmd === 'hat'
        ? '\u0302'
        : cmd === 'tilde'
          ? '\u0303'
          : cmd === 'vec'
            ? '\u20D7'
            : (cmd === 'mathring' || cmd === 'ring')
              ? '\u030A'
              : '\u0304';
    return t.length === 1 ? `${t}${comb}` : t;
  });

  s = s.replace(/\\\{/g, '{').replace(/\\\}/g, '}').replace(/\\\|/g, '‖').replace(/\\%/g, '%');

  s = s.replace(/\\([A-Za-z]+)/g, (full, name) => {
    if (Object.prototype.hasOwnProperty.call(LATEX_SYMBOL_MAP, name)) {
      return LATEX_SYMBOL_MAP[name];
    }
    return name;
  });

  s = s.replace(/_([A-Za-z0-9+\-=()])(?![A-Za-z0-9])/g, (_, ch) => mapScriptChars(ch, UNICODE_SUBSCRIPT_MAP, '_'));
  s = s.replace(/\^([A-Za-z0-9+\-=()*])(?![A-Za-z0-9])/g, (_, ch) => mapScriptChars(ch, UNICODE_SUPERSCRIPT_MAP, '^'));
  s = replaceLatexMacroWithOneArg(s, /_/g, (inner) => mapScriptChars(inner, UNICODE_SUBSCRIPT_MAP, '_'));
  s = replaceLatexMacroWithOneArg(s, /\^/g, (inner) => mapScriptChars(inner, UNICODE_SUPERSCRIPT_MAP, '^'));

  s = s.replace(/\{([^{}]+)\}/g, '$1').replace(/\{([^{}]+)\}/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

export function cleanLatexMathInText(text) {
  let out = String(text || '');
  if (!out) return out;

  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner) => latexToUnicode(inner));
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) => latexToUnicode(inner));
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) => latexToUnicode(inner));

  out = out.replace(/(?<!\\)\$([^\s$\n](?:[^\n$]*[^\s$\n])?)\$/g, (full, inner) => {
    const hasLatexOrMathOp = /[\\=^_{}<>]|[\u0370-\u03FF\u2200-\u22FF]/.test(inner);
    if (
      /^\d/.test(inner) &&
      !hasLatexOrMathOp &&
      (/\s+[a-z]{2,}/i.test(inner) || !/[+\-*/()]/.test(inner) || /[-–]$/.test(inner))
    ) {
      return full;
    }
    return latexToUnicode(inner);
  });

  if (/\\(?:text|mathrm|operatorname|mathbf|frac|sqrt|alpha|beta|gamma|theta|lambda|sigma|sum|prod|times|cdot|leq|geq|neq|approx|rightarrow)\b/.test(out)) {
    out = replaceLatexMacroWithOneArg(
      out,
      /\\(?:text|mathrm|operatorname|mathbf|mathit|mathsf|mathtt|boldsymbol|bm)\b/g,
      (inner) => inner
    );
    out = replaceLatexFrac(out);
    out = out.replace(/\\(alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|sigma|phi|psi|omega|Gamma|Delta|Theta|Lambda|Sigma|Phi|Psi|Omega|times|cdot|leq|geq|neq|approx|infty|sum|prod|partial|nabla|rightarrow|leftarrow|Rightarrow)\b/g,
      (_, name) => LATEX_SYMBOL_MAP[name] || name
    );
  }

  return out;
}

// ============================================================
// Smart Geometric Paragraph Grouping & Font Metadata Detection
// ============================================================
export function detectFontMeta(fontName, styles, commonObjs = null) {
  const style = styles?.[fontName] || null;
  let fontObj = null;
  if (commonObjs && fontName && typeof commonObjs.has === 'function' && commonObjs.has(fontName)) {
    try {
      fontObj = commonObjs.get(fontName);
    } catch (_) {
      fontObj = null;
    }
  }

  const actualName = String(fontObj?.name || '').trim();
  const fallbackName = String(fontObj?.fallbackName || '').trim();
  const styleFamily = String(style?.fontFamily || '').trim();
  const rawId = String(fontName || '').trim();
  const realNames = `${actualName} ${fallbackName} ${rawId}`;

  const isMono =
    styleFamily === 'monospace' ||
    MONO_FONT_REGEX.test(actualName) ||
    MONO_FONT_REGEX.test(fallbackName) ||
    MONO_FONT_REGEX.test(rawId);

  const isMathFont = !isMono && MATH_FONT_REGEX.test(realNames);

  // Determine isSerif from real font names BEFORE trusting PDF.js's default style.fontFamily ("sans-serif" fallback)
  let isSerif = false;
  if (!isMono) {
    if (actualName && SERIF_FONT_REGEX.test(actualName) && !SANS_FONT_REGEX.test(actualName)) {
      isSerif = true;
    } else if (actualName && SANS_FONT_REGEX.test(actualName)) {
      isSerif = false;
    } else if (
      styleFamily === 'serif' ||
      (fallbackName && SERIF_FONT_REGEX.test(fallbackName) && !SANS_FONT_REGEX.test(fallbackName)) ||
      (!actualName && SERIF_FONT_REGEX.test(rawId) && !SANS_FONT_REGEX.test(rawId))
    ) {
      isSerif = true;
    }
  }

  const fontWeightNum = Number(fontObj?.cssFontInfo?.fontWeight || 0);
  const isBold = Boolean(fontObj?.bold || fontObj?.black || fontWeightNum >= 600 || BOLD_FONT_REGEX.test(realNames));
  const italicAngle = Number(fontObj?.cssFontInfo?.italicAngle || 0);
  const isItalic = Boolean(fontObj?.italic || Math.abs(italicAngle) > 2 || ITALIC_FONT_REGEX.test(realNames));
  return { isSerif, isMono, isBold, isItalic, isMathFont };
}

function attachCombiningAccent(str, comb) {
  const trimmed = String(str || '').trimEnd();
  if (!trimmed) return str;
  const updated = trimmed.replace(/([^\s.,;:!?()[\]{}])([.,;:!?()[\]{}]*)$/, `$1${comb}$2`);
  return updated !== trimmed ? updated : `${trimmed}${comb}`;
}

function normalizeFractionAndAccents(spans) {
  if (!Array.isArray(spans) || spans.length <= 1) return spans;
  const consumed = new Set();
  const rebuilt = [];

  for (let i = 0; i < spans.length; i++) {
    if (consumed.has(i)) continue;
    const cur = spans[i];

    // Check adjacent span(s) for floating math accent above cur (or vice versa)
    if (!cur.scriptRole && i + 1 < spans.length && !consumed.has(i + 1)) {
      const next = spans[i + 1];
      if (next.scriptRole === 'accent' && ACCENT_GLYPH_TO_COMBINING[next.str.trim()]) {
        const comb = ACCENT_GLYPH_TO_COMBINING[next.str.trim()];
        consumed.add(i + 1);
        rebuilt.push({
          ...cur,
          str: attachCombiningAccent(cur.str, comb),
          right: Math.max(cur.right, next.right),
          top: Math.min(cur.top, next.top),
          bottom: Math.max(cur.bottom, next.bottom)
        });
        continue;
      }
    }
    if (cur.scriptRole === 'accent' && ACCENT_GLYPH_TO_COMBINING[cur.str.trim()] && i + 1 < spans.length && !consumed.has(i + 1)) {
      const next = spans[i + 1];
      if (!next.scriptRole) {
        const comb = ACCENT_GLYPH_TO_COMBINING[cur.str.trim()];
        consumed.add(i + 1);
        const trimmedNext = next.str.trimStart();
        const leadingWs = next.str.slice(0, next.str.length - trimmedNext.length);
        const updatedStr = trimmedNext.length >= 1
          ? `${leadingWs}${trimmedNext[0]}${comb}${trimmedNext.slice(1)}`
          : next.str;
        rebuilt.push({
          ...next,
          str: updatedStr,
          x: Math.min(cur.x, next.x),
          right: Math.max(cur.right, next.right),
          top: Math.min(cur.top, next.top),
          bottom: Math.max(cur.bottom, next.bottom)
        });
        continue;
      }
    }

    // Check stacked inline fraction pair: one 'sup' and one 'sub' horizontally overlapping/centered
    if ((cur.scriptRole === 'sup' || cur.scriptRole === 'sub') && i + 1 < spans.length && !consumed.has(i + 1)) {
      const next = spans[i + 1];
      const isOpposite =
        (cur.scriptRole === 'sup' && next.scriptRole === 'sub') ||
        (cur.scriptRole === 'sub' && next.scriptRole === 'sup');
      if (isOpposite) {
        const xOver = Math.min(cur.right, next.right) - Math.max(cur.x, next.x);
        const minW = Math.max(1, Math.min(cur.w || 1, next.w || 1));
        const maxW = Math.max(1, cur.w || 1, next.w || 1);
        const centerDiff = Math.abs((cur.x + cur.right) * 0.5 - (next.x + next.right) * 0.5);
        const horizGap = Math.max(0, next.x - cur.right);
        const maxFs = Math.max(cur.fontSize, next.fontSize);

        const prevSpan = rebuilt.length > 0 ? rebuilt[rebuilt.length - 1] : null;
        const prevEndsBase = Boolean(
          prevSpan &&
          !prevSpan.scriptRole &&
          /[A-Za-z\u0391-\u03C9)\]}|‖]$/.test(prevSpan.str.trimEnd())
        );
        const gapFromPrev = prevSpan ? (Math.min(cur.x, next.x) - prevSpan.right) : Infinity;

        const numSpan = cur.baselineY < next.baselineY ? cur : next;
        const denSpan = cur.baselineY < next.baselineY ? next : cur;
        const numTxt = numSpan.str.trim();
        const denTxt = denSpan.str.trim();

        const isSimultaneousScript =
          (prevEndsBase && gapFromPrev <= maxFs * 0.45) ||
          /^[=→∈≤≥≠]/.test(denTxt) ||
          /^[=+\-−,.;:]$/.test(numTxt) ||
          /^[=+\-−,.;:]$/.test(denTxt);

        if (
          !isSimultaneousScript &&
          (xOver > -0.2 * maxFs && (xOver > 0.1 * minW || centerDiff <= maxW * 0.85)) &&
          horizGap <= maxFs * 0.45
        ) {
          consumed.add(i + 1);
          const numFmt = /[+\-\s]/.test(numTxt) && !/^\(.*\)$/.test(numTxt) ? `(${numTxt})` : numTxt;
          const denFmt = /[+\-\s]/.test(denTxt) && !/^\(.*\)$/.test(denTxt) ? `(${denTxt})` : denTxt;
          rebuilt.push({
            ...cur,
            str: `${numFmt}/${denFmt}`,
            scriptRole: null,
            x: Math.min(cur.x, next.x),
            right: Math.max(cur.right, next.right),
            w: Math.max(cur.right, next.right) - Math.min(cur.x, next.x),
            top: Math.min(cur.top, next.top),
            bottom: Math.max(cur.bottom, next.bottom),
            fontSize: Math.max(cur.fontSize, next.fontSize)
          });
          continue;
        }
      }
    }

    if (cur.scriptRole === 'accent' && ACCENT_GLYPH_TO_COMBINING[cur.str.trim()] && rebuilt.length > 0) {
      // Attach trailing accent to previous span's base letter (before trailing punctuation)
      const prev = rebuilt[rebuilt.length - 1];
      const xOver = Math.min(prev.right, cur.right) - Math.max(prev.x, cur.x);
      if (xOver > -0.35 * cur.fontSize) {
        prev.str = attachCombiningAccent(prev.str, ACCENT_GLYPH_TO_COMBINING[cur.str.trim()]);
        continue;
      }
    }

    rebuilt.push(cur);
  }

  return rebuilt;
}

function coalesceAdjacentScripts(spans) {
  if (!Array.isArray(spans) || spans.length <= 1) return spans;
  const merged = [];
  for (const sp of spans) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    const maxFs = prev ? Math.max(prev.fontSize, sp.fontSize) : 0;
    const gap = prev ? (sp.x - prev.right) : Infinity;
    if (
      prev &&
      prev.scriptRole &&
      sp.scriptRole === prev.scriptRole &&
      gap >= -0.25 * maxFs &&
      gap <= 0.55 * maxFs
    ) {
      const joinSep = gap > 0.22 * maxFs ? ' ' : '';
      const nextRight = Math.max(prev.right, sp.right);
      merged[merged.length - 1] = {
        ...prev,
        str: `${prev.str.trimEnd()}${joinSep}${sp.str.trimStart()}`,
        right: nextRight,
        w: Math.max(1, nextRight - Math.min(prev.x, sp.x)),
        top: Math.min(prev.top, sp.top),
        bottom: Math.max(prev.bottom, sp.bottom)
      };
      continue;
    }
    merged.push(sp);
  }
  return merged;
}

function formatSpanText(sp, index) {
  const raw = sp.str;
  if (!sp.scriptRole) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  if (sp.scriptRole === 'sup') {
    if (index === 0 && /^[*†‡§¶∗⋆\d]+$/.test(trimmed)) {
      return trimmed;
    }
    if (/^[′'`"*∗†‡§¶⋆,.;:\s]+$/.test(trimmed)) {
      return trimmed;
    }
    return mapScriptChars(trimmed, UNICODE_SUPERSCRIPT_MAP, '^');
  }
  if (sp.scriptRole === 'sub') {
    if (/^[.,;:]+$/.test(trimmed)) return trimmed;
    return mapScriptChars(trimmed, UNICODE_SUBSCRIPT_MAP, '_');
  }
  return raw;
}

export function joinLineSpans(spans) {
  const ordered = coalesceAdjacentScripts(normalizeFractionAndAccents(spans));
  let out = '';
  let prev = null;
  for (let i = 0; i < ordered.length; i++) {
    const sp = ordered[i];
    const str = formatSpanText(sp, i);
    if (!str) continue;
    if (!prev) {
      out = str;
    } else {
      const gap = sp.x - prev.right;
      const avgFs = (sp.fontSize + prev.fontSize) * 0.5;
      const prevEndsSpace = /\s$/.test(out);
      const currStartsSpace = /^\s/.test(str);
      const prevLastChar = out.trimEnd().slice(-1);
      const currFirstChar = str.trimStart().slice(0, 1);
      const bothCjk = /[\p{Script=Han}\u3040-\u30ff]/u.test(prevLastChar) &&
        /[\p{Script=Han}\u3040-\u30ff]/u.test(currFirstChar);

      if (prevEndsSpace || currStartsSpace) {
        out = `${out.trimEnd()} ${str.trimStart()}`;
      } else if (prev.scriptRole && !sp.scriptRole) {
        const trimmedStart = str.trimStart();
        const needsSpace = /^[A-Za-z0-9\p{L}]/u.test(trimmedStart) && gap > avgFs * 0.08;
        out = needsSpace ? `${out.trimEnd()} ${trimmedStart}` : `${out}${trimmedStart}`;
      } else if (!prev.scriptRole && sp.scriptRole && gap <= avgFs * 0.25) {
        out += str.trim();
      } else if (!bothCjk && gap > avgFs * 0.16) {
        out = `${out} ${str}`;
      } else {
        out += str;
      }
    }
    prev = sp;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function joinParagraphLines(lines) {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const seg = lines[i].text.trim();
    if (!seg) continue;
    if (!out) {
      out = seg;
      continue;
    }
    if (/[a-zA-Z]-$/.test(out) && /^[a-z]/.test(seg)) {
      out = out.slice(0, -1) + seg;
    } else {
      const prevLast = out.slice(-1);
      const nextFirst = seg.slice(0, 1);
      const bothCjk = /[\p{Script=Han}\u3040-\u30ff]/u.test(prevLast) &&
        /[\p{Script=Han}\u3040-\u30ff]/u.test(nextFirst);
      out = bothCjk ? out + seg : `${out} ${seg}`;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function computeMedianFontSize(paragraphs) {
  const weighted = [];
  for (const p of paragraphs) {
    const len = p.text.length;
    if (len >= 20) {
      weighted.push({ fs: p.fontSize, weight: len });
    }
  }
  const source = weighted.length > 0
    ? weighted
    : paragraphs.map((p) => ({ fs: p.fontSize, weight: Math.max(1, p.text.length) }));
  if (source.length === 0) return 12;

  source.sort((a, b) => a.fs - b.fs);
  const totalWeight = source.reduce((acc, s) => acc + s.weight, 0);
  let acc = 0;
  for (const s of source) {
    acc += s.weight;
    if (acc >= totalWeight * 0.5) return s.fs;
  }
  return source[Math.floor(source.length / 2)].fs;
}

export function orderParagraphsReadingOrder(paragraphs, pageWidth) {
  if (!paragraphs || paragraphs.length <= 1) return paragraphs;
  const medianFs = computeMedianFontSize(paragraphs);
  const yEps = Math.min(3, Math.max(1.5, medianFs * 0.2));
  const minColGutter = Math.max(5, medianFs * 0.65);

  function sortFallback(items) {
    return items.slice().sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) <= Math.min(a.fontSize, b.fontSize) * 0.45) {
        return a.x - b.x;
      }
      return yDiff || (a.x - b.x);
    });
  }

  function findInteriorXValley(items) {
    const binW = 2;
    const numBins = Math.max(1, Math.ceil(pageWidth / binW));
    const occ = new Float32Array(numBins);
    let minItemX = Infinity;
    let maxItemRight = -Infinity;

    for (const p of items) {
      if (p.x < minItemX) minItemX = p.x;
      if (p.right > maxItemRight) maxItemRight = p.right;
      const b0 = Math.max(0, Math.floor(p.x / binW));
      const b1 = Math.min(numBins - 1, Math.floor(p.right / binW));
      for (let b = b0; b <= b1; b++) occ[b] += Math.max(1, p.h);
    }

    const searchMinX = Math.max(pageWidth * 0.18, minItemX + medianFs);
    const searchMaxX = Math.min(pageWidth * 0.82, maxItemRight - medianFs);
    if (searchMaxX <= searchMinX) return null;

    const minBin = Math.max(0, Math.floor(searchMinX / binW));
    const maxBin = Math.min(numBins - 1, Math.ceil(searchMaxX / binW));
    const margin = Math.max(4, medianFs * 0.35);

    let bestResult = null;
    let bestScore = Infinity;

    for (let b = minBin; b <= maxBin; b++) {
      if (occ[b] >= bestScore) continue;
      const gutterX = (b + 0.5) * binW;
      let leftCount = 0;
      let rightCount = 0;
      let straddleCount = 0;
      for (const p of items) {
        if (p.right <= gutterX + margin) leftCount++;
        else if (p.x >= gutterX - margin) rightCount++;
        else straddleCount++;
      }
      if (
        leftCount >= 2 &&
        rightCount >= 2 &&
        straddleCount > 0 &&
        straddleCount <= Math.max(2, Math.floor(items.length * 0.35))
      ) {
        bestScore = occ[b];
        bestResult = { gutterX, margin };
      }
    }

    return bestResult;
  }

  function xyCut(items, depth = 0) {
    if (items.length <= 1 || depth > 12) return sortFallback(items);

    const byTop = items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const yBands = [];
    let curBand = [byTop[0]];
    let maxBottom = byTop[0].bottom;
    for (let i = 1; i < byTop.length; i++) {
      const p = byTop[i];
      if (p.y >= maxBottom - yEps) {
        yBands.push(curBand);
        curBand = [p];
        maxBottom = p.bottom;
      } else {
        curBand.push(p);
        if (p.bottom > maxBottom) maxBottom = p.bottom;
      }
    }
    yBands.push(curBand);
    if (yBands.length > 1) {
      const out = [];
      for (const band of yBands) out.push(...xyCut(band, depth + 1));
      return out;
    }

    const byLeft = items.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    const xCols = [];
    let curCol = [byLeft[0]];
    let maxRight = byLeft[0].right;
    for (let i = 1; i < byLeft.length; i++) {
      const p = byLeft[i];
      if (p.x >= maxRight + minColGutter) {
        xCols.push(curCol);
        curCol = [p];
        maxRight = p.right;
      } else {
        curCol.push(p);
        if (p.right > maxRight) maxRight = p.right;
      }
    }
    xCols.push(curCol);
    if (xCols.length > 1) {
      const out = [];
      for (const col of xCols) out.push(...xyCut(col, depth + 1));
      return out;
    }

    const valley = findInteriorXValley(byTop);
    if (valley) {
      const subBands = [];
      let cur = [];
      const isStraddler = (p) => !(p.right <= valley.gutterX + valley.margin || p.x >= valley.gutterX - valley.margin);
      for (const p of byTop) {
        if (isStraddler(p)) {
          if (cur.length > 0) {
            subBands.push(cur);
            cur = [];
          }
          subBands.push([p]);
        } else {
          cur.push(p);
        }
      }
      if (cur.length > 0) subBands.push(cur);
      if (subBands.length > 1) {
        const out = [];
        for (const sb of subBands) out.push(...xyCut(sb, depth + 1));
        return out;
      }
    }

    return sortFallback(items);
  }

  return xyCut(paragraphs, 0);
}

export function extractPdfParagraphs(textContent, viewport, optionsOrCommonObjs = null) {
  let commonObjs = null;
  let transformFn = defaultMultiplyTransform;
  let hashFn = defaultHashText;

  if (optionsOrCommonObjs && typeof optionsOrCommonObjs === 'object') {
    if (
      'commonObjs' in optionsOrCommonObjs ||
      'transformFn' in optionsOrCommonObjs ||
      'hashFn' in optionsOrCommonObjs
    ) {
      commonObjs = optionsOrCommonObjs.commonObjs || null;
      if (typeof optionsOrCommonObjs.transformFn === 'function') {
        transformFn = optionsOrCommonObjs.transformFn;
      }
      if (typeof optionsOrCommonObjs.hashFn === 'function') {
        hashFn = optionsOrCommonObjs.hashFn;
      }
    } else {
      commonObjs = optionsOrCommonObjs;
    }
  }

  const rawItems = textContent?.items || [];
  const styles = textContent?.styles || {};
  if (rawItems.length === 0) return [];

  // 1. Convert PDF text items into CSS viewport coordinates
  const spans = [];
  for (const item of rawItems) {
    if (!item || typeof item.str !== 'string') continue;
    const trimmed = item.str.trim();
    if (!trimmed) continue;
    if (!Array.isArray(item.transform) || item.transform.length < 6) continue;

    const tx = transformFn(viewport.transform, item.transform);
    const angle = Math.atan2(tx[1], tx[0]);
    if (Math.abs(angle) > 0.25) continue;

    const fontSize = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || (item.height * viewport.scale) || 12;
    if (!Number.isFinite(fontSize) || fontSize < 3.8 * viewport.scale) continue;

    const x = tx[4];
    const baselineY = tx[5];
    let w = (item.width || 0) * viewport.scale;
    if (!Number.isFinite(w) || w <= 0) {
      w = trimmed.length * fontSize * 0.52;
    }
    const h = Math.max(fontSize * 1.14, (item.height || 0) * viewport.scale);
    const top = baselineY - fontSize * 0.88;
    const bottom = baselineY + fontSize * 0.24;

    if (x + w < 0 || x > viewport.width || bottom < 0 || top > viewport.height) {
      continue;
    }

    const fontMeta = detectFontMeta(item.fontName, styles, commonObjs);
    spans.push({
      str: item.str,
      charLen: trimmed.length,
      x,
      right: x + w,
      w,
      top,
      bottom,
      h,
      baselineY,
      fontSize,
      scriptRole: null,
      ...fontMeta
    });
  }

  if (spans.length === 0) return [];

  // 2a. Strict same-scale row clustering
  spans.sort((a, b) => (a.baselineY - b.baselineY) || (a.x - b.x));
  const rawRows = [];
  for (const sp of spans) {
    let matchedRow = null;
    const isSurdGlyph = sp.str.trim() === '√';
    for (let i = rawRows.length - 1; i >= 0; i--) {
      const row = rawRows[i];
      const minFs = Math.min(row.avgFontSize, sp.fontSize);
      const maxFs = Math.max(row.avgFontSize, sp.fontSize);
      const tol = 0.34 * minFs;
      if (Math.abs(sp.baselineY - row.baselineY) <= tol && maxFs / Math.max(0.1, minFs) <= 1.25) {
        if (
          isSurdGlyph &&
          row.spans.some((s) => (Math.min(sp.right, s.right) - Math.max(sp.x, s.x)) > 0.30 * sp.w)
        ) {
          continue;
        }
        matchedRow = row;
        break;
      }
      if (sp.baselineY - row.baselineY > maxFs * 1.2) {
        break;
      }
    }
    if (matchedRow) {
      const prevWeight = matchedRow.weight;
      const nextWeight = prevWeight + sp.charLen;
      matchedRow.baselineY = (matchedRow.baselineY * prevWeight + sp.baselineY * sp.charLen) / nextWeight;
      matchedRow.avgFontSize = (matchedRow.avgFontSize * prevWeight + sp.fontSize * sp.charLen) / nextWeight;
      matchedRow.weight = nextWeight;
      if (sp.top < matchedRow.top) matchedRow.top = sp.top;
      if (sp.bottom > matchedRow.bottom) matchedRow.bottom = sp.bottom;
      matchedRow.spans.push(sp);
    } else {
      rawRows.push({
        baselineY: sp.baselineY,
        avgFontSize: sp.fontSize,
        weight: sp.charLen,
        top: sp.top,
        bottom: sp.bottom,
        spans: [sp]
      });
    }
  }

  // 2b. Geometric Superscript / Subscript / Floating Accent Absorption
  rawRows.sort((a, b) => a.baselineY - b.baselineY);
  for (let rIdx = 0; rIdx < rawRows.length; rIdx++) {
    const row = rawRows[rIdx];
    const remainingSpans = [];
    for (const sp of row.spans) {
      const isAccentGlyph = Boolean(ACCENT_GLYPH_TO_COMBINING[sp.str.trim()]);
      let bestHost = null;
      let bestDist = Infinity;
      let bestRole = null;

      for (let hIdx = 0; hIdx < rawRows.length; hIdx++) {
        if (hIdx === rIdx) continue;
        const hostRow = rawRows[hIdx];
        const hostFs = hostRow.avgFontSize;

        if (isAccentGlyph) {
          const dyAccent = hostRow.baselineY - sp.baselineY;
          if (dyAccent < 0.04 * hostFs || dyAccent > 0.95 * hostFs) continue;
          if (sp.fontSize > 1.12 * hostFs) continue;
          let matchedLetter = false;
          let minAccentGap = Infinity;
          for (const h of hostRow.spans) {
            if (h.scriptRole) continue;
            const xOver = Math.min(sp.right, h.right) - Math.max(sp.x, h.x);
            const gap = Math.max(0, sp.x - h.right, h.x - sp.right);
            if (xOver >= -0.25 * hostFs && gap <= 0.35 * hostFs) {
              matchedLetter = true;
              if (gap < minAccentGap) minAccentGap = gap;
            }
          }
          if (!matchedLetter) continue;
          const dist = dyAccent + minAccentGap;
          if (dist < bestDist) {
            bestDist = dist;
            bestHost = hostRow;
            bestRole = 'accent';
          }
          continue;
        }

        if (sp.str.trim() === '√') {
          const dyRad = hostRow.baselineY - sp.baselineY;
          if (dyRad < 0.30 * hostFs || dyRad > 1.05 * hostFs) continue;
          if (sp.fontSize > 1.35 * hostFs) continue;
          let horizOverlap = false;
          let minRadGap = Infinity;
          let hasRightNeighbor = false;
          for (const h of hostRow.spans) {
            if (h.scriptRole) continue;
            const xOver = Math.min(sp.right, h.right) - Math.max(sp.x, h.x);
            if (xOver > 0.30 * sp.w) {
              horizOverlap = true;
              break;
            }
            const gapRight = h.x - sp.right;
            if (gapRight >= -0.25 * hostFs && gapRight <= 0.55 * hostFs) {
              hasRightNeighbor = true;
              if (Math.abs(gapRight) < minRadGap) minRadGap = Math.abs(gapRight);
            }
          }
          if (horizOverlap || !hasRightNeighbor) continue;
          const dist = dyRad + minRadGap * 0.1;
          if (dist < bestDist) {
            bestDist = dist;
            bestHost = hostRow;
            bestRole = null;
          }
          continue;
        }

        if (Math.abs(hostRow.baselineY - sp.baselineY) > 0.65 * hostFs) continue;
        if (row.avgFontSize > 0.90 * hostFs) continue;

        const sizeOk = sp.fontSize <= 0.85 * hostFs || (sp.fontSize <= 0.90 * hostFs && sp.charLen <= 3);
        if (!sizeOk) continue;
        // Full equation/prose phrases are never superscripts/subscripts; skip tall delimiter-only hosts (e.g. displayed '{')
        if (sp.charLen > 12 || sp.w > hostFs * 5.5) continue;
        if (
          hostRow.spans.length === 1 &&
          /^[{}()[\]|‖⟨⟩∑∏∫∮√]+$/.test(hostRow.spans[0].str.trim())
        ) {
          continue;
        }

        const dySup = hostRow.baselineY - sp.baselineY;
        const dySub = sp.baselineY - hostRow.baselineY;
        const isSuper = dySup >= 0.10 * hostFs && dySup <= 0.62 * hostFs && sp.bottom >= hostRow.top - 0.15 * hostFs;
        const isSub = dySub >= 0.06 * hostFs && dySub <= 0.48 * hostFs && sp.top <= hostRow.bottom + 0.12 * hostFs;
        if (!isSuper && !isSub) continue;

        let stackedOverlap = false;
        let minHorizGap = Infinity;
        let hasMainSpan = false;
        for (const h of hostRow.spans) {
          if (h.scriptRole) continue;
          hasMainSpan = true;
          const xOver = Math.min(sp.right, h.right) - Math.max(sp.x, h.x);
          if (xOver > 0.35 * sp.w) {
            stackedOverlap = true;
            break;
          }
          const hGap = Math.max(0, sp.x - h.right, h.x - sp.right);
          if (hGap < minHorizGap) minHorizGap = hGap;
        }
        if (!hasMainSpan || stackedOverlap || minHorizGap > 1.2 * hostFs) continue;

        const dist = Math.abs(hostRow.baselineY - sp.baselineY) + minHorizGap * 0.1;
        if (dist < bestDist) {
          bestDist = dist;
          bestHost = hostRow;
          bestRole = isSuper ? 'sup' : 'sub';
        }
      }

      if (bestHost) {
        sp.scriptRole = bestRole;
        if (bestRole === null && sp.str.trim() === '√') {
          // TeX \surd has a raised origin; align its vertical top/baseline with hostRow so it does not falsely overlap the line above
          sp.top = Math.max(sp.top, bestHost.top);
          sp.baselineY = bestHost.baselineY;
        }
        bestHost.spans.push(sp);
      } else {
        remainingSpans.push(sp);
      }
    }
    row.spans = remainingSpans;
  }

  const rows = rawRows.filter((r) => r.spans.length > 0);

  // 3. Split rows into column-safe horizontal line segments via contiguous gutter support
  for (const row of rows) {
    row.spans.sort((a, b) => a.x - b.x);
  }

  const binW = 2;
  const numBins = Math.max(1, Math.ceil(viewport.width / binW));
  const gapVotes = new Uint16Array(numBins);
  const bulletOnlyRe = /^(?:[•●▪▸►‣⁃◦–—\-*†‡§¶∗⋆]|(?:\(?\d{1,3}[.)])|[a-zA-Z][.)])$/;

  for (const row of rows) {
    let prevMaxRight = row.spans[0]?.right || 0;
    for (let i = 1; i < row.spans.length; i++) {
      const prev = row.spans[i - 1];
      const curr = row.spans[i];
      const gap = curr.x - prevMaxRight;
      const maxFs = Math.max(prev.fontSize, curr.fontSize);
      if (i === 1 && prev.w < 2.4 * maxFs && bulletOnlyRe.test(prev.str.trim())) {
        prevMaxRight = Math.max(prevMaxRight, curr.right);
        continue;
      }
      if (gap >= 1.0 * maxFs) {
        const b0 = Math.max(0, Math.floor(prevMaxRight / binW));
        const b1 = Math.min(numBins - 1, Math.floor(curr.x / binW));
        for (let b = b0; b <= b1; b++) gapVotes[b] += 1;
      }
      prevMaxRight = Math.max(prevMaxRight, curr.right);
    }
  }

  const rowBridgesX = (otherRow, xLeft, xRight, maxFs) => {
    const innerL = xLeft + 0.15 * maxFs;
    const innerR = xRight - 0.15 * maxFs;
    const xCenter = (xLeft + xRight) * 0.5;
    for (let i = 0; i < otherRow.spans.length; i++) {
      const s = otherRow.spans[i];
      if (s.right > innerL && s.x < innerR) return true;
      if (i > 0) {
        const p = otherRow.spans[i - 1];
        if (p.right <= xCenter && s.x >= xCenter && (s.x - p.right) < 0.95 * Math.max(p.fontSize, s.fontSize)) {
          return true;
        }
      }
    }
    return false;
  };

  const rowHasGutterAt = (otherRow, xCenter, maxFs) => {
    let hasLeft = false;
    let hasRight = false;
    let maxLeftRight = -Infinity;
    let minRightX = Infinity;
    const guardHalf = 0.25 * maxFs;
    for (const s of otherRow.spans) {
      if (s.x < xCenter + guardHalf && s.right > xCenter - guardHalf) return false;
      if (s.right <= xCenter - guardHalf) {
        hasLeft = true;
        if (s.right > maxLeftRight) maxLeftRight = s.right;
      } else if (s.x >= xCenter + guardHalf) {
        hasRight = true;
        if (s.x < minRightX) minRightX = s.x;
      }
    }
    return hasLeft && hasRight && (minRightX - maxLeftRight) >= 0.95 * maxFs;
  };

  const lines = [];
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    let segSpans = [row.spans[0]];
    let segMaxRight = row.spans[0].right;

    const flushSegment = (group) => {
      const text = joinLineSpans(group);
      if (!text) return;
      let minX = Infinity;
      let maxRight = -Infinity;
      let minTop = Infinity;
      let maxBottom = -Infinity;
      let totalWeight = 0;
      let mainWeight = 0;
      let fsSum = 0;
      let baselineSum = 0;
      let serifWeight = 0;
      let boldWeight = 0;
      let italicWeight = 0;
      let monoWeight = 0;
      let mathFontWeight = 0;

      for (const s of group) {
        if (s.x < minX) minX = s.x;
        if (s.right > maxRight) maxRight = s.right;
        if (s.top < minTop) minTop = s.top;
        if (s.bottom > maxBottom) maxBottom = s.bottom;
        totalWeight += s.charLen;
        if (!s.scriptRole) {
          mainWeight += s.charLen;
          fsSum += s.fontSize * s.charLen;
          baselineSum += s.baselineY * s.charLen;
        }
        if (s.isSerif) serifWeight += s.charLen;
        if (s.isBold) boldWeight += s.charLen;
        if (s.isItalic) italicWeight += s.charLen;
        if (s.isMono) monoWeight += s.charLen;
        if (s.isMathFont) mathFontWeight += s.charLen;
      }

      if (mainWeight === 0) {
        for (const s of group) {
          mainWeight += s.charLen;
          fsSum += s.fontSize * s.charLen;
          baselineSum += s.baselineY * s.charLen;
        }
      }

      const firstSpan = group[0];
      const startsWithSupMarker = Boolean(
        firstSpan &&
        firstSpan.scriptRole === 'sup' &&
        firstSpan.charLen <= 3 &&
        /^[*†‡§¶∗⋆\d]+$/.test(firstSpan.str.trim())
      );

      const lineObj = {
        text,
        x: minX,
        right: maxRight,
        w: Math.max(1, maxRight - minX),
        top: minTop,
        bottom: maxBottom,
        h: Math.max(1, maxBottom - minTop),
        baselineY: baselineSum / mainWeight,
        fontSize: fsSum / mainWeight,
        weight: totalWeight,
        mathFontWeight,
        isSerif: serifWeight > totalWeight * 0.5,
        isBold: boldWeight > totalWeight * 0.5,
        isItalic: italicWeight > totalWeight * 0.5,
        isMono: monoWeight > totalWeight * 0.6,
        startsWithSupMarker,
        isMathDisplayLine: false
      };
      lineObj.isMathDisplayLine = isDisplayedMathLine(lineObj, viewport.width);
      lines.push(lineObj);
    };

    for (let i = 1; i < row.spans.length; i++) {
      const prev = segSpans[segSpans.length - 1];
      const curr = row.spans[i];
      const gap = curr.x - segMaxRight;
      const maxFs = Math.max(prev.fontSize, curr.fontSize);
      const fsRatioDiff = Math.abs(prev.fontSize - curr.fontSize) / maxFs;
      const gapCenter = (segMaxRight + curr.x) * 0.5;

      let shouldSplit = false;
      const segWidth = segMaxRight - segSpans[0].x;
      const isBulletPrefix =
        segWidth < 2.4 * maxFs &&
        gap <= 2.8 * maxFs &&
        bulletOnlyRe.test(joinLineSpans(segSpans));

      if (!isBulletPrefix && gap > 0.95 * maxFs) {
        let contiguousClear = 1;
        for (let k = rIdx - 1; k >= 0; k--) {
          if (row.baselineY - rows[k].baselineY > 18 * maxFs) break;
          if (rowBridgesX(rows[k], segMaxRight, curr.x, maxFs)) break;
          if (rowHasGutterAt(rows[k], gapCenter, maxFs)) contiguousClear += 1;
        }
        for (let k = rIdx + 1; k < rows.length; k++) {
          if (rows[k].baselineY - row.baselineY > 18 * maxFs) break;
          if (rowBridgesX(rows[k], segMaxRight, curr.x, maxFs)) break;
          if (rowHasGutterAt(rows[k], gapCenter, maxFs)) contiguousClear += 1;
        }

        const voteBin = Math.max(0, Math.min(numBins - 1, Math.floor(gapCenter / binW)));
        const pageVotes = gapVotes[voteBin] || 0;

        shouldSplit =
          (contiguousClear >= 3 && gap >= 1.05 * maxFs) ||
          (contiguousClear >= 2 && gap >= 1.25 * maxFs) ||
          (gap > 1.35 * maxFs && fsRatioDiff > 0.25) ||
          (gap >= 1.15 * maxFs && pageVotes >= 4) ||
          gap > 2.6 * maxFs;
      }

      if (shouldSplit) {
        flushSegment(segSpans);
        segSpans = [curr];
        segMaxRight = curr.right;
      } else {
        segSpans.push(curr);
        if (curr.right > segMaxRight) segMaxRight = curr.right;
      }
    }
    flushSegment(segSpans);
  }

  // 4. Merge consecutive lines in the same column into coherent reading paragraphs
  lines.sort((a, b) => (a.top - b.top) || (a.x - b.x));
  const rawParagraphs = [];

  for (const line of lines) {
    let bestPara = null;
    let bestGap = Infinity;

    for (let i = rawParagraphs.length - 1; i >= 0; i--) {
      const p = rawParagraphs[i];
      const avgFs = (p.fontSize + line.fontSize) * 0.5;
      const vGap = line.top - p.bottom;

      if (vGap > 1.65 * avgFs) continue;
      if (vGap < -0.55 * avgFs) continue;
      if (line.baselineY - p.lastBaselineY < 0.45 * avgFs) continue;

      // Never merge displayed math equation lines with prose lines
      if (p.isMathOnly !== line.isMathDisplayLine) continue;

      const fsDiff = Math.abs(line.fontSize - p.fontSize) / Math.max(line.fontSize, p.fontSize);
      if (fsDiff > 0.12) continue;
      if (p.lines.length === 1 && p.fontSize >= line.fontSize * 1.08 && p.w < line.w * 0.80) {
        continue;
      }

      const overlap = Math.min(line.right, p.right) - Math.max(line.x, p.x);
      const minW = Math.min(line.w, p.w);
      const leftDiff = Math.abs(line.x - p.x);
      const centerDiff = Math.abs((line.x + line.right) * 0.5 - (p.x + p.right) * 0.5);
      const sameColumn =
        (overlap > 0 && (overlap >= 0.22 * minW || leftDiff <= 2.4 * avgFs)) ||
        centerDiff <= 2.2 * avgFs;
      if (!sameColumn) continue;

      const widthRatio = Math.max(line.w, p.w) / Math.max(1, minW);
      if (widthRatio > 2.2 && leftDiff > 4.0 * avgFs && centerDiff > 2.5 * avgFs) {
        continue;
      }
      // Two-way centered / inset block guard (up to 4 lines, e.g. multi-line centered equation above/below full-width prose)
      if (
        p.lines.length <= 4 &&
        line.w > p.w * 1.45 &&
        line.x < p.x - 1.5 * avgFs &&
        line.right > p.right + 1.5 * avgFs
      ) {
        continue;
      }
      if (
        p.w > line.w * 1.45 &&
        line.x > p.x + 1.5 * avgFs &&
        line.right < p.right - 1.5 * avgFs &&
        !/[.?!。？！]$/.test(line.text)
      ) {
        continue;
      }

      // Break on bullet / list / footnote item prefixes
      if (BULLET_PREFIX_REGEX.test(line.text) || FOOTNOTE_PREFIX_REGEX.test(line.text) || line.startsWithSupMarker) {
        continue;
      }

      if (p.isMono !== line.isMono) continue;

      const lastLine = p.lines[p.lines.length - 1];
      const pJoinedText = joinParagraphLines(p.lines);

      if (
        p.isBold &&
        !line.isBold &&
        p.lines.length <= 2 &&
        p.w < viewport.width * 0.72 &&
        (lastLine.w < line.w * 0.85 || !/[a-z,]$/.test(pJoinedText) || vGap > 0.22 * avgFs || p.fontSize > line.fontSize * 1.03)
      ) {
        continue;
      }
      if (
        !p.isBold &&
        line.isBold &&
        (line.w < p.w * 0.88 || vGap > 0.20 * avgFs || line.fontSize > p.fontSize * 1.03 || /^(\d+(?:\.\d+)*\.?\s+|[A-Z][a-z]+$)/.test(line.text))
      ) {
        continue;
      }

      if (
        p.isItalic !== line.isItalic &&
        p.lines.length === 1 &&
        (p.w < viewport.width * 0.45 || vGap > 0.25 * avgFs) &&
        !/[a-z,]-?$/.test(lastLine.text)
      ) {
        continue;
      }

      if (
        p.lines.length === 1 &&
        p.w < viewport.width * 0.28 &&
        line.w < viewport.width * 0.28 &&
        !/[-,;]$/.test(lastLine.text) &&
        !/^[a-z]/.test(line.text) &&
        !/\b(?:of|for|and|in|at|the|on|to|with|de|von|van)$/i.test(lastLine.text) &&
        lastLine.text.split(/\s+/).length <= 5 &&
        (/@|\{/.test(line.text) || (!/[.?!:]$/.test(lastLine.text) && centerDiff <= 1.2 * avgFs))
      ) {
        continue;
      }

      if (
        line.x - p.x > 1.25 * avgFs &&
        lastLine.right < p.right - 1.8 * avgFs
      ) {
        continue;
      }

      if (
        p.lines.length >= 2 &&
        lastLine.w < p.w * 0.72 &&
        /[.?!。？！:]$/.test(lastLine.text) &&
        vGap > 0.35 * avgFs
      ) {
        continue;
      }

      let blocked = false;
      for (let j = i + 1; j < rawParagraphs.length; j++) {
        const other = rawParagraphs[j];
        const xOver = Math.min(other.right, Math.max(line.right, p.right)) - Math.max(other.x, Math.min(line.x, p.x));
        const midY = (other.y + other.bottom) * 0.5;
        if (xOver > avgFs && midY > p.y && midY < line.bottom && other.y >= p.y + 1 && other.bottom <= line.bottom - 1) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      if (vGap < bestGap) {
        bestGap = vGap;
        bestPara = p;
      }
    }

    if (bestPara) {
      bestPara.lines.push(line);
      bestPara.x = Math.min(bestPara.x, line.x);
      bestPara.right = Math.max(bestPara.right, line.right);
      bestPara.w = bestPara.right - bestPara.x;
      bestPara.y = Math.min(bestPara.y, line.top);
      bestPara.bottom = Math.max(bestPara.bottom, line.bottom);
      bestPara.h = bestPara.bottom - bestPara.y;
      bestPara.lastBaselineY = line.baselineY;

      const nextW = bestPara.weight + line.weight;
      bestPara.fontSize = (bestPara.fontSize * bestPara.weight + line.fontSize * line.weight) / nextW;
      bestPara.serifWeight += line.isSerif ? line.weight : 0;
      bestPara.boldWeight += line.isBold ? line.weight : 0;
      bestPara.italicWeight += line.isItalic ? line.weight : 0;
      bestPara.monoWeight += line.isMono ? line.weight : 0;
      bestPara.mathFontWeight += line.mathFontWeight || 0;
      bestPara.weight = nextW;
      bestPara.isSerif = bestPara.serifWeight > nextW * 0.5;
      bestPara.isBold = bestPara.boldWeight > nextW * 0.5;
      bestPara.isItalic = bestPara.italicWeight > nextW * 0.5;
      bestPara.isMono = bestPara.monoWeight > nextW * 0.6;
    } else {
      rawParagraphs.push({
        lines: [line],
        x: line.x,
        right: line.right,
        w: line.w,
        y: line.top,
        bottom: line.bottom,
        h: line.h,
        lastBaselineY: line.baselineY,
        fontSize: line.fontSize,
        weight: line.weight,
        serifWeight: line.isSerif ? line.weight : 0,
        boldWeight: line.isBold ? line.weight : 0,
        italicWeight: line.isItalic ? line.weight : 0,
        monoWeight: line.isMono ? line.weight : 0,
        mathFontWeight: line.mathFontWeight || 0,
        isSerif: line.isSerif,
        isBold: line.isBold,
        isItalic: line.isItalic,
        isMono: line.isMono,
        isMathOnly: Boolean(line.isMathDisplayLine)
      });
    }
  }

  const finalized = rawParagraphs.map((p) => {
    const text = joinParagraphLines(p.lines);
    let avgLineHeightRatio = 1.32;
    if (p.lines.length >= 2) {
      let deltaSum = 0;
      for (let i = 1; i < p.lines.length; i++) {
        deltaSum += Math.max(p.fontSize, p.lines[i].baselineY - p.lines[i - 1].baselineY);
      }
      avgLineHeightRatio = (deltaSum / (p.lines.length - 1)) / Math.max(1, p.fontSize);
      avgLineHeightRatio = Math.max(1.18, Math.min(1.55, avgLineHeightRatio));
    }
    const isCentered =
      Math.abs((p.x + p.right) * 0.5 - viewport.width * 0.5) <= viewport.width * 0.08 &&
      p.w < viewport.width * 0.72;
    const endsWithEqNum = /\(\s*\d+(?:\.\d+)*[a-z]?\s*\)$/.test(text);
    const mathFontRatio = (p.mathFontWeight || 0) / Math.max(1, p.weight);

    return {
      text,
      key: hashFn(text),
      x: p.x,
      y: p.y,
      right: p.right,
      bottom: p.bottom,
      w: p.w,
      h: p.h,
      fontSize: p.fontSize,
      avgLineHeightRatio,
      lineCount: p.lines.length,
      isSerif: p.isSerif,
      isBold: p.isBold,
      isItalic: p.isItalic,
      isMono: p.isMono,
      isCentered,
      endsWithEqNum,
      mathFontRatio,
      isHeading: false,
      isCompactLabel: false,
      textNearestBelowY: viewport.height - 6,
      maxAllowedHeight: p.h + 4
    };
  });

  const medianFs = computeMedianFontSize(finalized);
  const ordered = orderParagraphsReadingOrder(finalized, viewport.width);

  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const isMathBlock =
      p.mathFontRatio >= 0.35 ||
      isDisplayedMathBlock(p.text, {
        isHeading: false,
        lineCount: p.lineCount,
        mathFontRatio: p.mathFontRatio,
        isCentered: p.isCentered,
        endsWithEqNum: p.endsWithEqNum
      });
    p.isHeading = !isMathBlock && (
      (p.fontSize >= 1.20 * medianFs &&
        p.lineCount <= 3 &&
        p.text.length <= 220 &&
        (p.isBold || p.fontSize >= 1.45 * medianFs || p.text.length <= 90 || !/[.?!。？！]$/.test(p.text))) ||
      (p.isBold &&
        p.fontSize >= 0.98 * medianFs &&
        p.lineCount <= 2 &&
        p.text.length <= 100 &&
        !/[.,;:]$/.test(p.text) &&
        (p.fontSize >= 1.08 * medianFs ||
          /^(?:\d+(?:\.\d+)*\.?\s+|abstract|introduction|background|related work|method|experiments?|results?|discussion|conclusion|references|appendix|acknowledg|summary|overview)/i.test(p.text)))
    );

    let nearestBelowY = viewport.height - 6;
    for (let j = 0; j < ordered.length; j++) {
      if (i === j) continue;
      const other = ordered[j];
      if (other.y < p.bottom - 2) continue;
      const xOverlap = Math.min(p.right, other.right) - Math.max(p.x, other.x);
      if (xOverlap > 4 && other.y < nearestBelowY) {
        nearestBelowY = other.y;
      }
    }
    p.textNearestBelowY = nearestBelowY;
    const availableGap = Math.max(0, nearestBelowY - p.bottom);
    const extraAllowance = Math.min(availableGap * 0.72, Math.max(4, p.fontSize * 0.85));
    p.maxAllowedHeight = p.h + 3 + extraAllowance;
  }

  return ordered;
}

// ============================================================
// Canvas Perimeter Pixel Sampling & Ink Obstacle Checking
// ============================================================
function computeLuminance(r, g, b) {
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(lumA, lumB) {
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

function medianValue(arr) {
  if (!arr.length) return 255;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function sampleParagraphColors(pageImageData, para, cssWidth, cssHeight, canvasWidth, canvasHeight) {
  if (!pageImageData || !pageImageData.data) {
    return { bg: '#ffffff', fg: '#111827', isDarkBg: false, bgRgb: [255, 255, 255] };
  }
  const data = pageImageData.data;
  const scaleX = canvasWidth / Math.max(1, cssWidth);
  const scaleY = canvasHeight / Math.max(1, cssHeight);

  const clampX = (px) => Math.max(0, Math.min(canvasWidth - 1, Math.round(px)));
  const clampY = (py) => Math.max(0, Math.min(canvasHeight - 1, Math.round(py)));

  const leftPx = para.x * scaleX;
  const rightPx = para.right * scaleX;
  const topPx = para.y * scaleY;
  const bottomPx = para.bottom * scaleY;
  const pad = Math.max(2, Math.round(2.5 * scaleX));

  const points = [];
  const horizSteps = 8;
  for (let i = 0; i <= horizSteps; i++) {
    const t = i / horizSteps;
    const px = leftPx + (rightPx - leftPx) * t;
    points.push([clampX(px), clampY(topPx - pad)]);
    points.push([clampX(px), clampY(bottomPx + pad)]);
  }
  const vertSteps = 5;
  for (let i = 1; i < vertSteps; i++) {
    const t = i / vertSteps;
    const py = topPx + (bottomPx - topPx) * t;
    points.push([clampX(leftPx - pad), clampY(py)]);
    points.push([clampX(rightPx + pad), clampY(py)]);
  }

  const rs = [];
  const gs = [];
  const bs = [];

  for (const [px, py] of points) {
    const offset = (py * canvasWidth + px) * 4;
    if (data[offset + 3] < 20) continue;
    rs.push(data[offset]);
    gs.push(data[offset + 1]);
    bs.push(data[offset + 2]);
  }

  if (rs.length === 0) {
    return { bg: '#ffffff', fg: '#111827', isDarkBg: false, bgRgb: [255, 255, 255] };
  }

  const r = medianValue(rs);
  const g = medianValue(gs);
  const b = medianValue(bs);
  const bgLum = computeLuminance(r, g, b);

  const lightInkLum = computeLuminance(248, 250, 252);
  const darkInkLum = computeLuminance(17, 24, 39);

  const isDarkBg = contrastRatio(bgLum, lightInkLum) > contrastRatio(bgLum, darkInkLum);
  const fg = isDarkBg ? '#f8fafc' : '#111827';
  const bg = `rgb(${r}, ${g}, ${b})`;

  return { bg, fg, isDarkBg, bgRgb: [r, g, b] };
}

export function refineMaxHeightWithCanvasInk(pageImageData, ordered, cssWidth, cssHeight, canvasWidth, canvasHeight) {
  if (!pageImageData || !pageImageData.data || !ordered || ordered.length === 0) return;
  const data = pageImageData.data;
  const scaleX = canvasWidth / Math.max(1, cssWidth);
  const scaleY = canvasHeight / Math.max(1, cssHeight);
  const xStepPx = Math.max(1, Math.round(2 * scaleX));

  for (const para of ordered) {
    const [bgR, bgG, bgB] = para.colors?.bgRgb || [255, 255, 255];

    const scanTopCss = para.bottom + Math.max(2.0, para.fontSize * 0.14);
    const textCeiling = Number.isFinite(para.textNearestBelowY) ? para.textNearestBelowY : (cssHeight - 6);
    const scanBottomCss = Math.min(textCeiling, para.bottom + Math.max(18, para.fontSize * 1.35));

    if (scanBottomCss > scanTopCss + 1) {
      const insetX = para.w > 24 ? 2 : 0;
      const xStartPx = Math.max(0, Math.min(canvasWidth - 1, Math.round((para.x + insetX) * scaleX)));
      const xEndPx = Math.max(xStartPx, Math.min(canvasWidth - 1, Math.round((para.right - insetX) * scaleX)));
      const yStartPx = Math.max(0, Math.min(canvasHeight - 1, Math.ceil(scanTopCss * scaleY)));
      const yEndPx = Math.max(yStartPx, Math.min(canvasHeight - 1, Math.floor(scanBottomCss * scaleY)));

      const samplesPerRow = Math.max(1, Math.floor((xEndPx - xStartPx) / xStepPx) + 1);
      const strongThreshold = Math.max(2, Math.ceil(samplesPerRow * 0.03));
      const tintThreshold = Math.max(2, Math.ceil(samplesPerRow * 0.25));

      let obstacleCssY = null;
      for (let py = yStartPx; py <= yEndPx; py++) {
        let strongHits = 0;
        let tintHits = 0;
        for (let px = xStartPx; px <= xEndPx; px += xStepPx) {
          const offset = (py * canvasWidth + px) * 4;
          if (data[offset + 3] < 20) continue;
          const dr = Math.abs(data[offset] - bgR);
          const dg = Math.abs(data[offset + 1] - bgG);
          const db = Math.abs(data[offset + 2] - bgB);
          const maxDiff = Math.max(dr, dg, db);
          const dist = dr + dg + db;
          if (maxDiff >= 40 || dist >= 75) {
            strongHits += 1;
            if (strongHits >= strongThreshold) break;
          } else if (maxDiff >= 24 || dist >= 48) {
            tintHits += 1;
          }
        }
        if (strongHits >= strongThreshold || tintHits >= tintThreshold) {
          obstacleCssY = py / scaleY;
          break;
        }
      }

      if (obstacleCssY !== null) {
        const nearestBelowY = Math.min(textCeiling, obstacleCssY - 1.5);
        const availableGap = Math.max(0, nearestBelowY - para.bottom);
        const extraAllowance = availableGap <= 1 ? 0 : Math.min(availableGap * 0.72, Math.max(2, para.fontSize * 0.85));
        const basePad = para.lineCount === 1 ? 1 : 3;
        para.maxAllowedHeight = Math.min(para.maxAllowedHeight, para.h + basePad + extraAllowance);
      }
    }

    para.isCompactLabel = false;
    if (para.lineCount === 1 && para.w < cssWidth * 0.32 && para.text.length <= 64) {
      const checkEdge = (pts) => {
        let hits = 0;
        for (const [cx, cy] of pts) {
          const px = Math.max(0, Math.min(canvasWidth - 1, Math.round(cx)));
          const py = Math.max(0, Math.min(canvasHeight - 1, Math.round(cy)));
          const offset = (py * canvasWidth + px) * 4;
          if (data[offset + 3] < 20) continue;
          const dr = Math.abs(data[offset] - bgR);
          const dg = Math.abs(data[offset + 1] - bgG);
          const db = Math.abs(data[offset + 2] - bgB);
          if (Math.max(dr, dg, db) >= 40 || (dr + dg + db) >= 75) {
            hits += 1;
            if (hits >= 2) return true;
          }
        }
        return false;
      };

      const lPx = para.x * scaleX;
      const rPx = para.right * scaleX;
      const tPx = para.y * scaleY;
      const bPx = para.bottom * scaleY;
      const d2 = 2.5 * scaleX;
      const d4 = 4.0 * scaleX;
      const dy2 = 2.5 * scaleY;
      const dy4 = 4.0 * scaleY;

      let borderedEdges = 0;
      const hPtsTop = [];
      const hPtsBot = [];
      for (let k = 0; k <= 4; k++) {
        const px = lPx + ((rPx - lPx) * k) / 4;
        hPtsTop.push([px, tPx - dy2], [px, tPx - dy4]);
        hPtsBot.push([px, bPx + dy2], [px, bPx + dy4]);
      }
      if (checkEdge(hPtsTop)) borderedEdges += 1;
      if (checkEdge(hPtsBot)) borderedEdges += 1;

      const vPtsLeft = [];
      const vPtsRight = [];
      for (let k = 0; k <= 3; k++) {
        const py = tPx + ((bPx - tPx) * k) / 3;
        vPtsLeft.push([lPx - d2, py], [lPx - d4, py]);
        vPtsRight.push([rPx + d2, py], [rPx + d4, py]);
      }
      if (checkEdge(vPtsLeft)) borderedEdges += 1;
      if (checkEdge(vPtsRight)) borderedEdges += 1;

      if (borderedEdges >= 2) {
        para.isCompactLabel = true;
      }
    }
  }
}
