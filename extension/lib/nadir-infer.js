// Nadir inference glue: page description (from extract.js + image stats) -> model inputs -> dark mapping.
// Mirrors train.py collate() for a single page. Works in browsers (offscreen document) and Node (parity tests).
(function (root) {
  'use strict';
  const MAX_TOK = 256, MAX_IMG = 32, FT = 49, FI = 41, K = 11, N_CTX = 32;
  const TREAT = ['keep', 'invert', 'adapt', 'remove'];
  const IMG_ROLES = ['photo', 'illustration', 'diagram', 'logo', 'icon', 'text', 'backdrop', 'avatar', 'ui'];
  const padF = (f) => { const o = new Array(FI).fill(0); for (let i = 0; i < Math.min(FI, f.length); i++) o[i] = Number.isFinite(f[i]) ? f[i] : 0; return o; };
  const FG_ROLES = new Set([1, 5, 6]); // text, svg fill, svg stroke
  const lin = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
  function oklab(r, g, b) {
    r = lin(r); g = lin(g); b = lin(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function labToRgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const enc = (x) => { x = Math.max(0, Math.min(1, x)); return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)); };
    return [enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), enc(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  }
  const relLum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const contrast = (a, b) => { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // WCAG target for a foreground token: 3:1 for large/bold text and graphics, 4.5:1 for body text
  const needOf = (t) => {
    if (t.role !== 1) return 3;
    const fs = t.f[21] * 32, bold = t.f[23] > 0.5;
    return (fs >= 24 || (fs >= 18.5 && bold)) ? 3 : 4.5;
  };
  const hex = (rgb, a) => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('') + (a < 0.999 ? Math.round(a * 255).toString(16).padStart(2, '0') : '');

  function putThumb(dst, j, thumb) { // RGBA bytes (32x32, row-major) -> planar floats
    if (!thumb || thumb.length !== 4096) return;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 4; c++)
      dst[j * 4096 + c * 1024 + y * 32 + x] = thumb[(y * 32 + x) * 4 + c] / 255;
  }

  // element head inputs: items [{f, thumb, ul: OKLab under (light), ud: OKLab under (dark)}], ctx Float32Array(32)
  function buildElemInputs(items, ctx) {
    const Kn = Math.max(1, items.length);
    const e_f = new Float32Array(Kn * FI), e_thumb = new Float32Array(Kn * 4096), ul = new Float32Array(Kn * 3), ud = new Float32Array(Kn * 3);
    items.forEach((it, k) => { e_f.set(padF(it.f), k * FI); putThumb(e_thumb, k, it.thumb); ul.set(it.ul, k * 3); ud.set(it.ud, k * 3); });
    return {K: items.length, feeds: {e_f: [e_f, [1, Kn, FI]], e_thumb: [e_thumb, [1, Kn, 4, 32, 32]], under_light: [ul, [1, Kn, 3]],
      under_dark: [ud, [1, Kn, 3]], ctx: [Float32Array.from(ctx), [1, N_CTX]]}};
  }
  // calibrated decisions: [{t: treatment, p: its probability, role, rp: role probability}]
  function decodeElements(treatLogits, roleLogits, K, temperature) {
    const T = temperature || 1, out = [];
    for (let k = 0; k < K; k++) {
      const z = Array.from(treatLogits.slice(k * 4, k * 4 + 4), (v) => v / T);
      const mx = Math.max(...z), e = z.map((v) => Math.exp(v - mx)), s = e.reduce((a, b) => a + b, 0);
      let best = 0; for (let c = 1; c < 4; c++) if (e[c] > e[best]) best = c;
      const r = Array.from(roleLogits.slice(k * 9, k * 9 + 9));
      const rm = Math.max(...r), re = r.map((v) => Math.exp(v - rm)), rs = re.reduce((a, b) => a + b, 0);
      let rb = 0; for (let c = 1; c < 9; c++) if (re[c] > re[rb]) rb = c;
      out.push({t: TREAT[best], p: +(e[best] / s).toFixed(3), probs: e.map((v) => +(v / s).toFixed(3)), role: IMG_ROLES[rb], rp: +(re[rb] / rs).toFixed(3)});
    }
    return out;
  }
  // the page's own images: the dark surface under each one is the palette head's raw output for its surface token
  function pageElementItems(page, out) {
    const toks = page.tokens.slice(0, MAX_TOK), n = toks.length;
    let root = 0; toks.forEach((t, i) => { if (t.f[24] > toks[root].f[24]) root = i; });
    const items = [], idx = [];
    page.images.forEach((im, j) => {
      if (!im.thumb || im.thumb.length !== 4096 || !im.f) return;
      const u = im.underTok != null && im.underTok >= 0 && im.underTok < n ? im.underTok : root;
      items.push({f: im.f, thumb: im.thumb, ul: [im.f[23], im.f[24] / 4, im.f[25] / 4], ud: Array.from(out.lab.slice(u * 3, u * 3 + 3)), u});
      idx.push(j);
    });
    return {items, idx};
  }

  function buildInputs(page) {
    const toks = page.tokens.slice(0, MAX_TOK);
    const N = Math.max(1, toks.length);
    const imgs = page.images.slice(0, MAX_IMG);
    const Mreal = imgs.length, M = Math.max(1, Mreal);
    const T = 1 + N + M;
    const tok_f = new Float32Array(N * FT), role = new BigInt64Array(N), lab = new Float32Array(N * 3);
    toks.forEach((t, i) => {
      tok_f.set(t.f.slice(0, FT).map((v) => (Number.isFinite(v) ? v : 0)), i * FT); role[i] = BigInt(t.role);
      const o = oklab(t.rgba[0], t.rgba[1], t.rgba[2]); lab.set(o, i * 3);
    });
    const img_f = new Float32Array(M * FI), thumbs = new Float32Array(M * 4 * 32 * 32);
    imgs.forEach((im, j) => {
      img_f.set(padF(im.f), j * FI);
      putThumb(thumbs, j, im.thumb);
    });
    const st = page.stats || {};
    const page_f = new Float32Array([page.vw / 1280, Math.min(8, page.docH / page.vh) / 8, toks.length / MAX_TOK, Mreal / MAX_IMG,
      page.darkness.bgL, page.darkness.textL, page.canvasDark ? 1 : 0, Math.min(1, (st.tokensDropped || 0) / 200)]);
    // relations
    const rel = new Float32Array(T * T * K);
    const n = toks.length;
    const R = new Float32Array(4 * (n + 1) * (n + 1));
    const P = n + 1;
    const tbBest = new Map();
    for (const r of page.rel) {
      const [typ, a, b, w] = r;
      if (a >= n || b >= n) continue;
      const idx = typ * P * P + (a + 1) * P + (b + 1);
      if (w > R[idx]) R[idx] = w;
      if (typ === 0) { const cur = tbBest.get(a); if (!cur || w > cur[0]) tbBest.set(a, [w, b]); }
    }
    for (let k = 0; k < 4; k++) for (let a = 0; a < P; a++) {
      let mx = 0; for (let b = 0; b < P; b++) mx = Math.max(mx, R[k * P * P + a * P + b]);
      const den = mx + 1e-6;
      for (let b = 0; b < P; b++) {
        const v = R[k * P * P + a * P + b] / den;
        if (!v) continue;
        rel[(a * T + b) * K + k] = v;          // a -> b
        rel[(b * T + a) * K + 4 + k] = v;      // transpose channel
      }
    }
    imgs.forEach((im, j) => {
      const u = im.underTok;
      if (u != null && u >= 0 && u < n) { rel[((1 + N + j) * T + (1 + u)) * K + 8] = 1; rel[((1 + u) * T + (1 + N + j)) * K + 9] = 1; }
    });
    const keyOf = (t) => t.rgba[0] * 65536 + t.rgba[1] * 256 + t.rgba[2];
    const byKey = new Map();
    toks.forEach((t, i) => { const k = keyOf(t); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(i); });
    for (const list of byKey.values()) if (list.length > 1) for (const i of list) for (const j of list) if (i !== j) rel[((1 + i) * T + (1 + j)) * K + 10] = 1;
    const mask = new Uint8Array(T);
    for (let i = 0; i <= n; i++) mask[i] = 1;
    for (let j = 0; j < Mreal; j++) mask[1 + N + j] = 1;
    return {N, M, T, Mreal, tbBest, feeds: {
      tok_f: [tok_f, [1, N, FT]], tok_role: [role, [1, N]], tok_lab: [lab, [1, N, 3]], img_f: [img_f, [1, M, FI]], img_thumb: [thumbs, [1, M, 4, 32, 32]],
      page_f: [page_f, [1, 8]], src: [new BigInt64Array([0n]), [1]], rel: [rel, [1, T, T, K]], mask: [mask, [1, T]],
    }};
  }

  // outputs: lab Float32Array(N*3), alpha_logit Float32Array(N), ctx Float32Array(32)
  // brand colours keep their hue: a coloured input whose output drifts more than 45 degrees is turned back to its
  // own hue (keeping the predicted lightness and chroma); neutral inputs get at most a faint tint
  function hueGuard(t, o) {
    const i = oklab(t.rgba[0], t.rgba[1], t.rgba[2]), q = oklab(...o.rgb);
    const cin = Math.hypot(i[1], i[2]), cout = Math.hypot(q[1], q[2]);
    if (cin > 0.03 && cout > 0.03) {
      const d = Math.abs(((Math.atan2(q[2], q[1]) - Math.atan2(i[2], i[1]) + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (d <= Math.PI / 4) return;
      const h = Math.atan2(i[2], i[1]);
      o.rgb = labToRgb(q[0], cout * Math.cos(h), cout * Math.sin(h));
    } else if (cin <= 0.03 && cout > 0.06) {
      o.rgb = labToRgb(q[0], q[1] * 0.06 / cout, q[2] * 0.06 / cout);
    }
  }

  function decode(page, built, out, opts) {
    opts = opts || {};
    const toks = page.tokens.slice(0, MAX_TOK);
    const n = toks.length;
    const outputs = new Array(n);
    const keep = new Set();
    toks.forEach((t, i) => {
      const L = out.lab[i * 3], a = out.lab[i * 3 + 1], b = out.lab[i * 3 + 2];
      const ain = Math.min(1 - 1e-3, Math.max(1e-3, t.rgba[3]));
      const alpha = 1 / (1 + Math.exp(-(out.alpha_logit[i] + Math.log(ain / (1 - ain)))));
      outputs[i] = {rgb: labToRgb(L, a, b), a: t.rgba[3] >= 0.999 && alpha > 0.97 ? 1 : alpha, L};
      // colours over video/photos that already read as dark mode (dark scrims, saturated player accents, light
      // captions and icons) are shown as-is; anything else over media is redesigned like any other colour
      const f = t.f;
      const bgLike = t.role === 0 || t.role === 3 || t.role === 4;
      if (f[48] >= 0.5 && (bgLike ? (f[24] <= 0.5 && f[11] < 0.25 && (f[0] < 0.5 || f[3] > 0.4)) : f[0] > 0.6)) {
        keep.add(i);
        const rgb = t.rgba.slice(0, 3);
        outputs[i] = {rgb, a: t.rgba[3], L: oklab(...rgb)[0]};
      } else hueGuard(t, outputs[i]);
    });
    // a see-through light panel (frosted card, glass button: white at 40-99% opacity) stays see-through but turns
    // dark; left mid-grey it is a surface no text colour reads on (the contrast pass below only sees opaque ones)
    toks.forEach((t, i) => {
      if (keep.has(i) || t.role !== 0 || t.rgba[3] >= 0.999 || t.rgba[3] < 0.4) return;
      if (oklab(t.rgba[0], t.rgba[1], t.rgba[2])[0] < 0.85 || outputs[i].L <= 0.45) return;
      const o = oklab(...outputs[i].rgb);
      outputs[i].rgb = labToRgb(0.24, o[1] * 0.5, o[2] * 0.5); outputs[i].L = 0.24;
    });
    // safety: page canvas must be dark
    toks.forEach((t, i) => {
      if (t.f[24] > 0.5 && t.role === 0 && outputs[i].L > 0.35) { const o = oklab(...outputs[i].rgb); outputs[i].rgb = labToRgb(0.2, o[1] * 0.3, o[2] * 0.3); outputs[i].L = 0.2; }
    });
    // an opaque surface stays opaque: see-through, it would show whatever the design stacks beneath it (a hidden
    // sticky header, the next slide). The predicted colour is composited over the dark canvas instead
    const canvasI = toks.findIndex((t) => t.f[24] > 0.5 && t.role === 0);
    const under = canvasI >= 0 ? outputs[canvasI].rgb : [18, 18, 20];
    toks.forEach((t, i) => {
      if (keep.has(i) || t.role !== 0 || t.rgba[3] < 0.999 || outputs[i].a >= 0.999) return;
      const a = outputs[i].a;
      outputs[i].rgb = outputs[i].rgb.map((c, k) => Math.round(c * a + under[k] * (1 - a)));
      outputs[i].a = 1; outputs[i].L = oklab(...outputs[i].rgb)[0];
    });
    // things that were invisible against their surface stay invisible: gradient stops with exactly a surface's
    // colour (text fades) take that surface's dark colour, and so do borders that matched their surface
    const keyOf = (t) => t.rgba[0] * 65536 + t.rgba[1] * 256 + t.rgba[2];
    const surfOf = new Map();
    toks.forEach((t, i) => { if (t.role === 0 && t.rgba[3] >= 0.999 && !keep.has(i) && outputs[i].a >= 0.999 && !surfOf.has(keyOf(t))) surfOf.set(keyOf(t), i); });
    toks.forEach((t, i) => {
      if (t.role === 4 && !keep.has(i) && surfOf.has(keyOf(t))) { const j = surfOf.get(keyOf(t)); outputs[i].rgb = outputs[j].rgb.slice(); outputs[i].L = outputs[j].L; }
    });
    const borderOn = new Map();
    for (const [typ, a, b, w] of page.rel) {
      if (typ !== 2 || a >= n || b >= n || toks[a].role !== 2 || toks[b].role !== 0) continue;
      const cur = borderOn.get(a); if (!cur || w > cur[0]) borderOn.set(a, [w, b]);
    }
    for (const [i, [, j]] of borderOn) {
      if (keep.has(i) || keep.has(j)) continue;
      if (contrast(toks[i].rgba, toks[j].rgba) < 1.05 && toks[i].rgba[3] >= 0.5) { outputs[i].rgb = outputs[j].rgb.slice(); outputs[i].L = outputs[j].L; }
    }
    // an SVG shape painted in a surface colour and invisible on what it sits on (inverted corners, section caps)
    // is part of that surface, not ink: it takes the surface colour's dark output
    const fillOn = new Map();
    for (const [typ, a, b, w] of page.rel) {
      if (typ !== 0 || a >= n || b >= n || (toks[a].role !== 5 && toks[a].role !== 6) || toks[b].role !== 0) continue;
      const cur = fillOn.get(a); if (!cur || w > cur[0]) fillOn.set(a, [w, b]);
    }
    for (const [i, [, j]] of fillOn) {
      const t = toks[i];
      if (keep.has(i) || t.rgba[3] < 0.999 || !surfOf.has(keyOf(t))) continue;
      if (contrast(t.rgba, toks[j].rgba) < 1.1) { const k = surfOf.get(keyOf(t)); outputs[i].rgb = outputs[k].rgb.slice(); outputs[i].L = outputs[k].L; }
    }
    // safety: every foreground colour (text, svg fill/stroke) stays readable on all the surfaces it sits on,
    // never asking for more contrast than the light design had; one lightness per shared token, chosen on a grid
    const surf = new Map();
    for (const [typ, a, b, w] of page.rel) {
      if (typ !== 0 || a >= n || b >= n || toks[b].role !== 0 || outputs[b].a < 0.999) continue;
      if (!surf.has(a)) surf.set(a, []);
      surf.get(a).push([b, Math.expm1(w) + 1]); // rels store log1p(weight)
    }
    for (const [i, lst] of surf) {
      const t = toks[i];
      if (keep.has(i) || !FG_ROLES.has(t.role) || outputs[i].a < 0.999) continue;
      let need0 = needOf(t);
      if (opts.minContrast) need0 = Math.min(need0, opts.minContrast);
      const reqs = [];
      for (const [j, w] of lst) {
        const need = Math.min(need0, contrast(t.rgba, toks[j].rgba));
        if (need >= 1.5) reqs.push([outputs[j].rgb, need, w]);
      }
      if (!reqs.length) continue;
      const deficit = (rgb) => { let d = 0; for (const [bg, need, w] of reqs) d += w * Math.max(0, Math.log(need) - Math.log(contrast(rgb, bg))); return d; };
      if (deficit(outputs[i].rgb) <= 0) continue;
      const o = oklab(...outputs[i].rgb);
      let W = 0; for (const r of reqs) W += r[2];
      let best = null;
      for (let k = 0; k <= 50; k++) {
        const Lx = k / 50, rgb = labToRgb(Lx, o[1], o[2]);
        // moving away from the model's lightness costs: the surfaces a colour mostly sits on decide, and a few
        // bright accent surfaces cannot drag it to a mid-grey that reads nowhere (they are rescued below)
        const c = deficit(rgb) / W + Math.abs(Lx - o[0]);
        if (!best || c < best[0]) best = [c, rgb, Lx];
      }
      outputs[i].rgb = best[1]; outputs[i].L = best[2];
    }
    // a light surface whose text no longer reads (its text colour follows the dark page) is darkened within its
    // own hue until that text reads again: a yellow note becomes dark gold, not a glare
    const fgOn = new Map();
    for (const [typ, a, b, w] of page.rel) {
      if (typ !== 0 || a >= n || b >= n || toks[b].role !== 0 || !FG_ROLES.has(toks[a].role)) continue;
      if (!fgOn.has(b)) fgOn.set(b, []);
      fgOn.get(b).push([a, Math.expm1(w) + 1]);
    }
    for (const [j, lst] of fgOn) {
      const s = toks[j];
      if (keep.has(j) || s.f[24] > 0.5 || outputs[j].a < 0.999 || outputs[j].L < 0.6) continue;
      const reqs = [];
      for (const [i, w] of lst) {
        if (keep.has(i) || outputs[i].a < 0.999) continue;
        const need = Math.min(needOf(toks[i]), contrast(toks[i].rgba, s.rgba));
        if (need >= 1.5) reqs.push([outputs[i].rgb, need, w]);
      }
      if (!reqs.length) continue;
      let W = 0; for (const r of reqs) W += r[2];
      const fail = (rgb) => { let f = 0; for (const [fg, need, w] of reqs) if (contrast(fg, rgb) < need) f += w; return f / W; };
      if (fail(outputs[j].rgb) <= 0.5) continue;
      const o = oklab(...outputs[j].rgb);
      for (let k = Math.floor(o[0] * 50); k >= 10; k--) {
        const rgb = labToRgb(k / 50, o[1], o[2]);
        if (fail(rgb) <= 0.2) { outputs[j].rgb = rgb; outputs[j].L = k / 50; break; }
      }
    }
    const colors = toks.map((t, i) => keep.has(i) ? null : hex(outputs[i].rgb, outputs[i].a));
    return {colors, keep: [...keep], Ls: outputs.map((o) => +o.L.toFixed(3))}; // Ls: the lightness each colour is shown at
  }

  const api = {buildInputs, decode, buildElemInputs, decodeElements, pageElementItems, oklab, labToRgb, TREAT, IMG_ROLES, MAX_TOK, MAX_IMG, FI};
  root.NadirInfer = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
