import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectFontMeta,
  joinLineSpans,
  isDisplayedMathBlock,
  isDisplayedMathLine,
  shouldTranslatePdfText,
  isUntranslatedEcho,
  isOverlayNoOp,
  protectInlineMath,
  restoreMathPlaceholders,
  cleanLatexMathInText,
  extractPdfParagraphs
} from '../shared/pdf-layout.mjs';

function makeViewport(width = 612, height = 792, scale = 1) {
  return {
    width: width * scale,
    height: height * scale,
    scale,
    // Standard PDF-to-viewport flip matrix (origin bottom-left -> top-left)
    transform: [scale, 0, 0, -scale, 0, height * scale]
  };
}

function pdfMultiply(vpTx, itemTx) {
  const [a1, b1, c1, d1, e1, f1] = vpTx;
  const [a2, b2, c2, d2, e2, f2] = itemTx;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1
  ];
}

function makeSpanItem(str, x, pdfY, fontSize = 10, fontName = 'g_d0_f1', width = null) {
  const w = width ?? str.length * fontSize * 0.48;
  return {
    str,
    dir: 'ltr',
    width: w,
    height: fontSize,
    transform: [fontSize, 0, 0, fontSize, x, pdfY],
    fontName,
    hasEOL: false
  };
}

function makeMockCommonObjs(mapObj) {
  return {
    has: (k) => Object.prototype.hasOwnProperty.call(mapObj, k),
    get: (k) => mapObj[k]
  };
}

test('detectFontMeta ignores PDF.js generic sans-serif style fallback on Computer Modern / LaTeX fonts', () => {
  const commonObjs = makeMockCommonObjs({
    f_sfrm: { name: 'ABCDE+SFRM1000', fallbackName: 'sans-serif' },
    f_cmbx: { name: 'FGHIJ+CMBX12', bold: true },
    f_cmmi: { name: 'KLMNO+CMMI10', italic: true },
    f_cmsy: { name: 'PQRST+CMSY10' },
    f_cmex: { name: 'UVWXY+CMEX10' },
    f_cmtt: { name: 'ZZZ11+CMTT10' },
    f_cmss: { name: 'AAA22+CMSS10' },
    f_helv: { name: 'Helvetica' },
    f_lib: { name: 'BBB33+LinLibertineT' }
  });
  const styles = {
    f_sfrm: { fontFamily: 'sans-serif' },
    f_cmbx: { fontFamily: 'sans-serif' },
    f_cmmi: { fontFamily: 'sans-serif' },
    f_cmsy: { fontFamily: 'sans-serif' },
    f_cmex: { fontFamily: 'sans-serif' },
    f_cmtt: { fontFamily: 'sans-serif' },
    f_cmss: { fontFamily: 'sans-serif' },
    f_helv: { fontFamily: 'sans-serif' },
    f_lib: { fontFamily: 'sans-serif' }
  };

  const sfrm = detectFontMeta('f_sfrm', styles, commonObjs);
  assert.equal(sfrm.isSerif, true);
  assert.equal(sfrm.isMono, false);

  const cmbx = detectFontMeta('f_cmbx', styles, commonObjs);
  assert.equal(cmbx.isSerif, true);
  assert.equal(cmbx.isBold, true);

  const cmmi = detectFontMeta('f_cmmi', styles, commonObjs);
  assert.equal(cmmi.isMathFont, true);
  assert.equal(cmmi.isItalic, true);

  const cmsy = detectFontMeta('f_cmsy', styles, commonObjs);
  assert.equal(cmsy.isMathFont, true);

  const cmex = detectFontMeta('f_cmex', styles, commonObjs);
  assert.equal(cmex.isMathFont, true);

  const cmtt = detectFontMeta('f_cmtt', styles, commonObjs);
  assert.equal(cmtt.isMono, true);
  assert.equal(cmtt.isSerif, false);

  const cmss = detectFontMeta('f_cmss', styles, commonObjs);
  assert.equal(cmss.isSerif, false);
  assert.equal(cmss.isMono, false);

  const helv = detectFontMeta('f_helv', styles, commonObjs);
  assert.equal(helv.isSerif, false);

  const lib = detectFontMeta('f_lib', styles, commonObjs);
  assert.equal(lib.isSerif, true);
});

test('LaTeX Minkowski-curvature page: isolates displayed eq, preserves fractions/scripts/accents, separates footnotes', () => {
  const viewport = makeViewport(612, 792, 1);
  const commonObjs = makeMockCommonObjs({
    f_rm: { name: 'AAAAA+SFRM1000' },
    f_bx: { name: 'BBBBB+CMBX10', bold: true },
    f_mi: { name: 'CCCCC+CMMI10', italic: true },
    f_sy: { name: 'DDDDD+CMSY10' },
    f_ex: { name: 'EEEEE+CMEX10' },
    f_fn: { name: 'FFFFF+SFRM0800' }
  });
  // Deliberately simulate PDF.js setting style.fontFamily = 'sans-serif' on all Computer Modern fonts
  const styles = Object.fromEntries(
    ['f_rm', 'f_bx', 'f_mi', 'f_sy', 'f_ex', 'f_fn'].map((k) => [k, { fontFamily: 'sans-serif' }])
  );

  const items = [
    // Heading: Abstract (centered)
    makeSpanItem('Abstract', 284, 710, 10, 'f_bx', 44),

    // Intro prose ending before equation
    makeSpanItem('In this paper, we study the classification and evolution of bifurcation curves', 85, 682, 10, 'f_rm', 442),
    makeSpanItem('of positive classical solutions for the one-dimensional Minkowski-curvature problem', 85, 669, 10, 'f_rm', 442),
    makeSpanItem('with Robin boundary conditions', 85, 656, 10, 'f_rm', 140),

    // Displayed 2-line brace equation (centered vertically overlapping brace + equation)
    makeSpanItem('{', 175, 622, 18, 'f_ex', 10),
    makeSpanItem("-(u'/√(1-u'^2))' = λf(u), in (-L, L),", 190, 628, 10, 'f_mi', 210),
    makeSpanItem("u'(0) = 0 and u'(L) + αu(L) = 0,", 190, 610, 10, 'f_mi', 180),

    // Main prose paragraph immediately following equation (with 1/α stacked fraction, scripts, L-ring)
    makeSpanItem('where L, α, λ > 0 and f ∈ C', 85, 582, 10, 'f_rm', 135),
    makeSpanItem('1', 221, 586, 6.5, 'f_rm', 4),
    makeSpanItem('[0, ∞) ∩ C', 226, 582, 10, 'f_rm', 55),
    makeSpanItem('2', 282, 586, 6.5, 'f_rm', 4),
    makeSpanItem('(0, ∞) satisfies f(s) > 0 for s > 0.', 287, 582, 10, 'f_rm', 190),

    // Line with ‖u‖_∞ = L + 1/α and S_L
    makeSpanItem('By developing a coupled Robin time-map analysis, we determine ‖u‖', 85, 569, 10, 'f_rm', 300),
    makeSpanItem('∞', 386, 566.5, 6.5, 'f_sy', 6),
    makeSpanItem(' = L + ', 393, 569, 10, 'f_rm', 30),
    // Stacked inline fraction 1 over α at same X!
    makeSpanItem('1', 425, 574.2, 6.5, 'f_rm', 6),
    makeSpanItem('α', 425, 565.5, 6.5, 'f_mi', 6),
    makeSpanItem(' of S', 433, 569, 10, 'f_rm', 24),
    makeSpanItem('L', 458, 566.5, 6.5, 'f_mi', 5),
    makeSpanItem('.', 463, 569, 10, 'f_rm', 3),

    // Line with 3ηα² and f^(3)(0^+) and floating ring accent over L
    makeSpanItem('If f', 85, 556, 10, 'f_rm', 16),
    makeSpanItem('(3)', 102, 560, 6.5, 'f_rm', 9),
    makeSpanItem('(0', 112, 556, 10, 'f_rm', 10),
    makeSpanItem('+', 122, 560, 6.5, 'f_rm', 5),
    makeSpanItem(') ≥ 3ηα', 128, 556, 10, 'f_rm', 36),
    makeSpanItem('2', 165, 560, 6.5, 'f_rm', 4),
    makeSpanItem(', it transitions for 0 < L < ', 170, 556, 10, 'f_rm', 130),
    makeSpanItem('˚', 302, 562.5, 7, 'f_rm', 5),
    makeSpanItem('L', 301, 556, 10, 'f_mi', 7),
    makeSpanItem(' and holds for L > ', 309, 556, 10, 'f_rm', 85),
    makeSpanItem('˚', 396, 562.5, 7, 'f_rm', 5),
    makeSpanItem('L.', 395, 556, 10, 'f_mi', 10),

    // Footnotes at bottom (tight spacing + superscript footnote markers)
    makeSpanItem('*', 78, 120, 6, 'f_sy', 4),
    makeSpanItem('2020 Mathematics Subject Classification: 34B15, 34B18, 34C23.', 85, 117, 8, 'f_fn', 290),
    makeSpanItem('†', 78, 107, 6, 'f_sy', 4),
    makeSpanItem('Department of Mathematics and Information Education, National Taipei University of Education,', 85, 104, 8, 'f_fn', 390),
    makeSpanItem('Taipei 106, Taiwan.', 85, 94, 8, 'f_fn', 90),
    makeSpanItem('‡', 78, 84, 6, 'f_sy', 4),
    makeSpanItem('Department of Mathematics and Information Education, National Taipei University of Education.', 85, 81, 8, 'f_fn', 390)
  ];

  const paras = extractPdfParagraphs(
    { items, styles },
    viewport,
    { commonObjs, transformFn: pdfMultiply }
  );

  // 1. All LaTeX body/heading paragraphs must detect Serif (not sans-serif!)
  const abstractPara = paras.find((p) => p.text === 'Abstract');
  assert.ok(abstractPara, 'Abstract heading must exist');
  assert.equal(abstractPara.isSerif, true);

  // 2. Intro prose must NOT swallow the displayed equation below it
  const introPara = paras.find((p) => p.text.startsWith('In this paper'));
  assert.ok(introPara, 'Intro paragraph must exist');
  assert.ok(!introPara.text.includes('λf(u)'), 'Intro paragraph must not swallow displayed equation');
  assert.equal(introPara.isSerif, true);

  // 3. Displayed 2-line equation must be isolated as its own block and skipped for translation
  const eqPara = paras.find((p) => p.text.includes('λf(u)') && p.text.includes('αu(L)'));
  assert.ok(eqPara, '2-line displayed equation must remain separated from surrounding prose');
  assert.equal(eqPara.isHeading, false, 'Displayed math equation must never be marked as heading');
  assert.equal(
    shouldTranslatePdfText(eqPara.text, 'zh-TW', {
      isHeading: eqPara.isHeading,
      isMono: eqPara.isMono,
      lineCount: eqPara.lineCount,
      widthRatio: eqPara.w / viewport.width,
      mathFontRatio: eqPara.mathFontRatio,
      isCentered: eqPara.isCentered,
      endsWithEqNum: eqPara.endsWithEqNum
    }),
    false,
    'Displayed equation block must not be sent for translation'
  );

  // 4. Main "where L, α, λ > 0" 3-line prose block must NOT contain the displayed equation above it
  const bodyPara = paras.find((p) => p.text.startsWith('where L, α, λ > 0'));
  assert.ok(bodyPara, 'Main body paragraph starting with "where L..." must exist separately');
  assert.equal(bodyPara.lineCount, 3, 'All 3 body prose lines must merge cleanly into one paragraph');
  assert.ok(!bodyPara.text.includes('u\'(0)'), 'Main body paragraph must NOT absorb equation line above');
  assert.equal(
    shouldTranslatePdfText(bodyPara.text, 'zh-TW', {
      isHeading: bodyPara.isHeading,
      isMono: bodyPara.isMono,
      lineCount: bodyPara.lineCount,
      widthRatio: bodyPara.w / viewport.width,
      mathFontRatio: bodyPara.mathFontRatio,
      isCentered: bodyPara.isCentered,
      endsWithEqNum: bodyPara.endsWithEqNum
    }),
    true
  );

  // 5. Verify inline fraction, super/subscripts, and combining ring accent (before trailing period!)
  assert.ok(bodyPara.text.includes('1/α'), `Expected "1/α" (not "α1") in: ${bodyPara.text}`);
  assert.ok(!bodyPara.text.includes('α1'), `Should not invert fraction into α1: ${bodyPara.text}`);
  assert.ok(bodyPara.text.includes('C¹') || bodyPara.text.includes('C^1'), `Expected superscript C¹ in: ${bodyPara.text}`);
  assert.ok(bodyPara.text.includes('C²') || bodyPara.text.includes('C^2'), `Expected superscript C² in: ${bodyPara.text}`);
  assert.ok(bodyPara.text.includes('3ηα²') || bodyPara.text.includes('3ηα^2'), `Expected 3ηα² in: ${bodyPara.text}`);
  assert.ok(bodyPara.text.includes('‖u‖_∞') || bodyPara.text.includes('‖u‖∞'), `Expected ‖u‖_∞ in: ${bodyPara.text}`);
  assert.ok(bodyPara.text.includes('S_L'), `Expected S_L in: ${bodyPara.text}`);
  assert.ok(bodyPara.text.includes('f⁽³⁾(0⁺)') || bodyPara.text.includes('f^(3)(0^+)'), `Expected f⁽³⁾(0⁺) in: ${bodyPara.text}`);
  assert.ok(bodyPara.text.includes('L\u030A.'), `Expected combining ring accent L̊. before period in: ${bodyPara.text}`);
  assert.ok(!bodyPara.text.includes('.\u030A'), `Combining accent must attach to L, never period: ${bodyPara.text}`);
  assert.ok(!/˚\s+L/.test(bodyPara.text), `Should not leave detached spacing ring accent: ${bodyPara.text}`);

  // 6. Footnotes must stay separated into 3 distinct blocks
  const fn1 = paras.find((p) => p.text.includes('2020 Mathematics Subject Classification'));
  const fn2 = paras.find((p) => p.text.includes('Taipei 106, Taiwan.') && p.text.includes('†'));
  const fn3 = paras.find((p) => p.text.includes('‡'));
  assert.ok(fn1 && fn2 && fn3, 'All three footnote markers (*, †, ‡) must preserve separate footnote paragraphs');
  assert.ok(!fn1.text.includes('†'), 'Footnote 1 must not merge Footnote 2');
  assert.ok(!fn2.text.includes('‡'), 'Footnote 2 must not merge Footnote 3');
});

test('isDisplayedMathBlock & isDisplayedMathLine recognize displayed equations with "in"/"and" while sparing prose', () => {
  assert.equal(
    isDisplayedMathBlock("-(u'/√(1-u'^2))' = λf(u), in (-L, L),\nu'(0) = 0 and u'(L) + αu(L) = 0,", {
      lineCount: 2,
      isCentered: true,
      mathFontRatio: 0.25
    }),
    true
  );
  assert.equal(
    isDisplayedMathLine({
      text: "u'(0) = 0 and u'(L) + αu(L) = 0,",
      x: 190,
      right: 370,
      w: 180,
      weight: 30,
      mathFontWeight: 8
    }, 612),
    true
  );
  assert.equal(
    isDisplayedMathBlock(
      'where L, α, λ > 0 and f ∈ C¹[0, ∞) ∩ C²(0, ∞) satisfies f(s) > 0 for s > 0. By developing a coupled Robin time-map analysis we obtain exact existence results.',
      { lineCount: 3, isCentered: false, mathFontRatio: 0.05 }
    ),
    false
  );
});

test('isUntranslatedEcho rejects verbatim English echoes for CJK targets and spares valid translations', () => {
  const src =
    'where L, α, λ > 0 and f satisfies positive solutions for the one-dimensional Minkowski-curvature problem [[M0]]';
  const echo =
    'where L, α, λ > 0 and f satisfies positive solutions for the one-dimensional Minkowski-curvature problem [[M0]]';
  const goodZh =
    '其中 L, α, λ > 0 且 f 滿足一維明考斯基曲率問題的正古典解 [[M0]]。';

  assert.equal(isUntranslatedEcho(src, echo, 'zh-TW'), true);
  assert.equal(isUntranslatedEcho(src, echo, 'zh-CN'), true);
  assert.equal(isUntranslatedEcho(src, echo, 'ja'), true);
  assert.equal(isUntranslatedEcho(src, goodZh, 'zh-TW'), false);
  assert.equal(isUntranslatedEcho('Transformer', 'Transformer', 'zh-TW'), false);
});

test('protectInlineMath & restoreMathPlaceholders protect inequalities/formulas round-trip cleanly', () => {
  const input = 'Thus it transitions for 0 < L < L\u030A to C-like with asymptote 1/α and threshold 3ηα².';
  const { text, placeholders } = protectInlineMath(input);
  assert.ok(placeholders.size >= 1, 'Expected inline math expressions to be tokenized');
  assert.ok(Array.from(placeholders.values()).some((v) => v.includes('L\u030A')), 'Expected 0 < L < L̊ in placeholders');
  const mockTranslated = text.replace('Thus it transitions for', '因此當').replace('to C-like with asymptote', '時轉為 C 型且漸近線為').replace('and threshold', '，門檻為');
  const restored = cleanLatexMathInText(restoreMathPlaceholders(mockTranslated, placeholders));
  assert.ok(!/\[\[M\d+\]\]/.test(restored), 'No placeholder token should remain');
  assert.ok(restored.includes('0 < L < L\u030A'), 'Protected inequality should survive translation');
  assert.ok(restored.includes('1/α'), 'Protected fraction should survive translation');
  assert.ok(restored.includes('3ηα²'), 'Protected threshold should survive translation');
});

test('joinLineSpans keeps script roles and cleans combining accents', () => {
  const lineText = joinLineSpans([
    { str: 'C', x: 10, right: 16, fontSize: 10, scriptRole: null },
    { str: '1', x: 16, right: 20, fontSize: 6.5, scriptRole: 'sup' },
    { str: ' and S', x: 20, right: 48, fontSize: 10, scriptRole: null },
    { str: 'L', x: 48, right: 53, fontSize: 6.5, scriptRole: 'sub' }
  ]);
  assert.equal(lineText, 'C¹ and S_L');
  const authorWithOpAst = joinLineSpans([
    { str: 'Ashish Vaswani', x: 10, right: 80, fontSize: 10, scriptRole: null },
    { str: '∗', x: 80, right: 84, fontSize: 7, scriptRole: 'sup' }
  ]);
  assert.equal(authorWithOpAst, 'Ashish Vaswani∗');
});

test('Two-column XY-cut orders spanning title before left column before right column', () => {
  const viewport = makeViewport(612, 792, 1);
  // Staggered vertical ranges across columns so no horizontal whitespace band crosses both columns
  const items = [
    makeSpanItem('A Unified Approach to Two-Column Layout', 120, 720, 14, 'f1', 370),
    makeSpanItem('Right column starts here and spans three wrapped lines', 330, 655, 10, 'f1', 210),
    makeSpanItem('overlapping vertically with left column paragraphs so', 330, 642, 10, 'f1', 210),
    makeSpanItem('it bridges the left gap.', 330, 629, 10, 'f1', 105),
    makeSpanItem('Left column starts here with a two-line paragraph block', 70, 660, 10, 'f1', 210),
    makeSpanItem('ending with a short line.', 70, 647, 10, 'f1', 105),
    makeSpanItem('Left column second paragraph continues below after a break', 70, 620, 10, 'f1', 210),
    makeSpanItem('and bridges across the right column gap inside left.', 70, 607, 10, 'f1', 210),
    makeSpanItem('Right column second paragraph follows below right first.', 330, 602, 10, 'f1', 210)
  ];
  const paras = extractPdfParagraphs(
    { items, styles: { f1: { fontFamily: 'serif' } } },
    viewport,
    { transformFn: pdfMultiply }
  );
  assert.equal(paras.length, 5);
  assert.ok(paras[0].text.startsWith('A Unified'));
  assert.ok(paras[1].text.startsWith('Left column starts'));
  assert.ok(paras[2].text.startsWith('Left column second'));
  assert.ok(paras[3].text.startsWith('Right column starts'));
  assert.ok(paras[4].text.startsWith('Right column second'));
});

test('normalizeFractionAndAccents keeps W_i^Q & sum limits intact while merging stacked 1/α', () => {
  const wiq = joinLineSpans([
    { str: 'W', x: 10, right: 20, fontSize: 10, scriptRole: null },
    { str: 'Q', x: 20, right: 25, fontSize: 7, baselineY: 96, top: 90, bottom: 98, w: 5, scriptRole: 'sup' },
    { str: 'i', x: 20, right: 24, fontSize: 7, baselineY: 102, top: 96, bottom: 104, w: 4, scriptRole: 'sub' },
    { str: ' and L + ', x: 26, right: 64, fontSize: 10, baselineY: 100, top: 91, bottom: 102, w: 38, scriptRole: null },
    { str: '1', x: 66, right: 72, fontSize: 6.5, baselineY: 94.8, top: 89, bottom: 96, w: 6, scriptRole: 'sup' },
    { str: 'α', x: 66, right: 72, fontSize: 6.5, baselineY: 103.5, top: 98, bottom: 105, w: 6, scriptRole: 'sub' }
  ]);
  assert.ok(wiq.includes('W^Qᵢ') || wiq.includes('W^Q'), `Expected simultaneous script intact: ${wiq}`);
  assert.ok(!wiq.includes('WQ/i') && !wiq.includes('Q/i'), `Must not misparse W_i^Q as fraction: ${wiq}`);
  assert.ok(wiq.includes('1/α'), `Expected stacked fraction 1/α intact: ${wiq}`);

  const sumLimits = joinLineSpans([
    { str: 'k', x: 10, right: 16, fontSize: 7, baselineY: 92, top: 86, bottom: 94, w: 6, scriptRole: 'sup' },
    { str: '=1', x: 10, right: 18, fontSize: 7, baselineY: 104, top: 98, bottom: 106, w: 8, scriptRole: 'sub' }
  ]);
  assert.ok(!sumLimits.includes('k/=1'), `Must not merge limit "=1" as fraction denominator: ${sumLimits}`);
});

test('Real Page 4 Attention raw spans merge into ONE paragraph with √dₖ', () => {
  const viewport = makeViewport(612, 792, 1);
  // Mirror PDF.js coordinates from arXiv 1706.03762 p.4 (baselineY = 792 - pdfY)
  const item = (str, x, cssBaselineY, fs, w) => makeSpanItem(str, x, 792 - cssBaselineY, fs, 'f_rm', w);
  const items = [
    item('We call our particular attention "Scaled Dot-Product Attention" (Figure 2). The input consists of', 107.5, 377.3, 9.96, 396.5),
    item('queries and keys of dimension', 108, 388.2, 9.96, 121.2),
    item('d', 231.7, 388.2, 9.96, 5.2),
    item('k', 236.8, 389.7, 6.97, 4.2),
    item(', and values of dimension', 241.7, 388.2, 9.96, 102),
    item('d', 346.3, 388.2, 9.96, 5.2),
    item('v', 351.5, 389.7, 6.97, 4),
    item('. We compute the dot products of the', 356.2, 388.2, 9.96, 147.8),
    item('query with all keys, divide each by', 108, 399.2, 9.96, 139.6),
    item('√', 250, 391.4, 9.96, 8.3),
    item('d', 258.4, 399.2, 9.96, 5.2),
    item('k', 263.5, 400.6, 6.97, 4.2),
    item(', and apply a softmax function to obtain the weights on the', 268.4, 399.2, 9.96, 235.6),
    item('values.', 107.8, 410.1, 9.96, 27.7)
  ];
  const paras = extractPdfParagraphs(
    { items, styles: { f_rm: { fontFamily: 'serif' } } },
    viewport,
    { transformFn: pdfMultiply }
  );
  assert.equal(paras.length, 1, `Expected 1 unified paragraph, got ${paras.length}: ${JSON.stringify(paras.map((p) => p.text))}`);
  assert.ok(paras[0].text.includes('divide each by √d'), `Expected inline radical √dₖ in: ${paras[0].text}`);
  assert.ok(paras[0].text.includes('dᵥ. We compute'), `Must not split row after overlapped dᵥ: ${paras[0].text}`);
});

test('Multi-marker author superscripts, d_model subscripts, and coalesced superscripts format cleanly', () => {
  const multiAuthor = joinLineSpans([
    { str: 'Aidan N. Gomez', x: 10, right: 85, fontSize: 10, scriptRole: null },
    { str: '∗', x: 85, right: 89, fontSize: 7, scriptRole: 'sup' },
    { str: '†', x: 92, right: 96, fontSize: 7, scriptRole: 'sup' }
  ]);
  assert.equal(multiAuthor, 'Aidan N. Gomez∗ †');

  const dModel = joinLineSpans([
    { str: 'd', x: 10, right: 16, fontSize: 10, scriptRole: null },
    { str: 'model', x: 16, right: 38, fontSize: 6.5, scriptRole: 'sub' }
  ]);
  assert.equal(dModel, 'd_model');
  assert.ok(!dModel.includes('{'), 'Must not leak raw LaTeX braces in d_model');

  const coalescedSup = joinLineSpans([
    { str: 'R', x: 10, right: 18, fontSize: 10, scriptRole: null },
    { str: 'd', x: 18, right: 23, fontSize: 7, scriptRole: 'sup' },
    { str: 'model', x: 23, right: 38, fontSize: 5.5, scriptRole: 'sup' },
    { str: '×', x: 38.5, right: 43, fontSize: 7, scriptRole: 'sup' },
    { str: 'd', x: 43, right: 48, fontSize: 7, scriptRole: 'sup' }
  ]);
  assert.ok(!coalescedSup.includes('^d^model'), `Expected coalesced superscript without repeated carets: ${coalescedSup}`);
});

test('ALL-CAPS matrix equations are excluded, and non-bold sentence disclaimers are not headings', () => {
  assert.equal(
    shouldTranslatePdfText('MultiHead(Q, K, V ) = Concat(head₁, ..., headₕ)W^O where headᵢ= Attention(QWᵢ^Q, KWᵢ^K, V Wᵢ^V)', 'zh-TW', {
      isHeading: false,
      lineCount: 2,
      mathFontRatio: 0.36,
      isCentered: true
    }),
    false
  );

  const viewport = makeViewport(612, 792, 1);
  const items = [
    makeSpanItem('Provided proper attribution is provided, Google hereby grants permission to reproduce', 80, 710, 12, 'f_rm', 450),
    makeSpanItem('the tables and figures in this paper solely for use in journalistic or scholarly works.', 80, 695, 12, 'f_rm', 440),
    makeSpanItem('Standard body text establishes the median font size for this document across multiple lines', 80, 620, 10, 'f_rm', 440),
    makeSpanItem('so that the median calculation picks up regular 10pt prose accurately in our test fixture.', 80, 607, 10, 'f_rm', 440)
  ];
  const paras = extractPdfParagraphs(
    { items, styles: { f_rm: { fontFamily: 'serif' } } },
    viewport,
    { transformFn: pdfMultiply }
  );
  const notice = paras.find((p) => p.text.startsWith('Provided proper attribution'));
  assert.ok(notice, 'Permission notice paragraph must exist');
  assert.equal(notice.isHeading, false, 'Non-bold sentence-terminated permission disclaimer must not be marked isHeading');
});

test('Title-Case author lists are not flagged as echoes, and isOverlayNoOp avoids redundant overlays', () => {
  const authorLine = 'Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan Gomez';
  assert.equal(isUntranslatedEcho(authorLine, authorLine, 'zh-TW'), false);
  assert.equal(
    isUntranslatedEcho('This paragraph clearly explains our optimization algorithm across all benchmarks.', 'This paragraph clearly explains our optimization algorithm across all benchmarks.', 'zh-TW'),
    true
  );

  assert.equal(isOverlayNoOp('Attention Is All You Need', 'Attention Is All You Need'), true);
  assert.equal(isOverlayNoOp('Jakob Uszkoreit∗', 'Jakob Uszkoreit*'), true);
  assert.equal(isOverlayNoOp('University of Toronto', '多倫多大學'), false);
});
