// Nadir colour mapping runtime: turns per-token dark colours (from the model or a teacher) into a lookup
// for every colour the page might use. Shared by the extension and the evaluation renderer.
(function () {
  'use strict';
  const ROLES = ['bg', 'text', 'border', 'shadow', 'gradient', 'fill', 'stroke'];
  // which token roles answer a query role, in order of preference
  const CHAIN = {
    bg: ['bg', 'gradient', 'shadow'],
    gradient: ['gradient', 'bg', 'shadow'],
    shadow: ['shadow', 'bg', 'gradient'],
    text: ['text', 'fill', 'stroke'],
    fill: ['fill', 'text', 'stroke'],
    stroke: ['stroke', 'fill', 'text'],
    border: ['border', 'bg', 'stroke'],
  };
  const lin = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
  function oklab(r, g, b) {
    r = lin(r); g = lin(g); b = lin(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function toRgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const enc = (x) => { x = Math.max(0, Math.min(1, x)); return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)); };
    return [enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), enc(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  }
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const keyOf = (r, g, b, a) => hex2(r) + hex2(g) + hex2(b) + hex2(Math.round(a * 255));
  function css(rgb, a) {
    return a >= 0.999 ? `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}` : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${+a.toFixed(3)})`;
  }
  function parseHex(h) {
    h = h.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }

  class NadirMap {
    // tokens: [{role, rgba:[r,g,b,a]}]; outputs: same length, each '#rrggbb[aa]' | [r,g,b,a] | null
    // opts.keep: set of token indices that must stay unchanged (media overlays)
    constructor(tokens, outputs, opts) {
      opts = opts || {};
      this.exact = {};           // role -> key -> css
      this.pts = {};             // role -> [{lab, alpha, dl, da, db, dA}]
      for (const r of ROLES) { this.exact[r] = new Map(); this.pts[r] = []; }
      this.fillL = new Map();    // SVG fill colour -> output lightness
      const keep = opts.keep || new Set();
      tokens.forEach((t, i) => {
        let o = outputs[i];
        if (keep.has(i)) o = t.rgba;
        if (o == null) return;
        if (typeof o === 'string') o = parseHex(o);
        const role = typeof t.role === 'number' ? ROLES[t.role] : t.role;
        const [r, g, b, a] = t.rgba;
        this.exact[role].set(keyOf(r, g, b, a), css([o[0], o[1], o[2]], o[3] == null ? a : o[3]));
        const li = oklab(r, g, b), lo = oklab(o[0], o[1], o[2]);
        if (role === 'fill' && !keep.has(i)) this.fillL.set(keyOf(r, g, b, a), lo[0]); // media keeps say nothing about ink
        this.pts[role].push({lab: li, alpha: a, d: [lo[0] - li[0], lo[1] - li[1], lo[2] - li[2]], out: lo, oA: o[3] == null ? a : o[3]});
      });
      this.cache = new Map();
      this.maxDist = opts.maxDist || 0.16;
    }
    // An SVG fill the model saw on this page: drawn as light ink (logo, icon) or as a dark surface (wave, panel)?
    // null when the colour was never seen as a fill: the engine then falls back to its own size heuristic.
    fillSide(r, g, b, a) {
      const L = this.fillL.get(keyOf(r, g, b, a));
      return L == null ? null : (L >= 0.5 ? 'fg' : 'bg');
    }
    lookup(role, r, g, b, a) {
      const ck = role + keyOf(r, g, b, a);
      let v = this.cache.get(ck);
      if (v !== undefined) return v;
      v = this._lookup(role, r, g, b, a);
      this.cache.set(ck, v);
      return v;
    }
    _lookup(role, r, g, b, a) {
      const key = keyOf(r, g, b, a);
      const chain = CHAIN[role] || [role];
      for (const rr of chain) { const e = this.exact[rr].get(key); if (e) return e; }
      // nearest-neighbour transfer within the role chain (first role with points)
      const q = oklab(r, g, b);
      let best = [];
      for (let ci = 0; ci < chain.length; ci++) {
        const pts = this.pts[chain[ci]];
        for (const p of pts) {
          const dl = p.lab[0] - q[0], da = p.lab[1] - q[1], db = p.lab[2] - q[2];
          const d = Math.sqrt(dl * dl * 1.5 + da * da + db * db + (p.alpha - a) * (p.alpha - a) * 0.25) + ci * 0.03;
          best.push([d, p]);
        }
        if (best.length >= 6) break;
      }
      if (!best.length) return null;
      best.sort((x, y) => x[0] - y[0]);
      best = best.slice(0, 4);
      if (best[0][0] > this.maxDist) return null; // too far from anything the model saw: built-in fallback
      let w = 0, d0 = 0, d1 = 0, d2 = 0, dA = 0;
      for (const [d, p] of best) {
        const wi = 1 / (d * d + 1e-4);
        w += wi; d0 += p.d[0] * wi; d1 += p.d[1] * wi; d2 += p.d[2] * wi; dA += (p.oA - p.alpha) * wi;
      }
      const L = Math.max(0, Math.min(1, q[0] + d0 / w));
      // keep chroma direction of the query, scale like the neighbours did
      const rgb = toRgb(L, q[1] + d1 / w, q[2] + d2 / w);
      const alpha = Math.max(0, Math.min(1, a + dA / w));
      return css(rgb, alpha);
    }
  }

  // image treatments as CSS
  const TREAT_CSS = {
    invert: 'filter: invert(1) hue-rotate(180deg) !important;',
    light: 'filter: brightness(0) invert(0.92) !important;',
    dim: 'filter: brightness(0.88) !important;',
    plate: 'background-color: rgba(255,255,255,0.92) !important; box-shadow: 0 0 0 3px rgba(255,255,255,0.92) !important; border-radius: 4px !important;',
  };
  // ---------- flat graphics on a white background (logos, icons, diagrams): adapt the image itself ----------
  // The white background becomes transparent so the page's own dark surface shows through, neutral ink flips to
  // light, and brand colours keep their hue and are lifted only as far as needed to read on dark.
  function adaptPixels(d, w, h, info) {
    info = info || {};
    let n = 0, light = 0, sr = 0, sg = 0, sb = 0, ringN = 0;
    const ringPx = (p) => {
      const i = p * 4;
      ringN++;
      if (d[i + 3] < 250) return;
      n++;
      const o = oklab(d[i], d[i + 1], d[i + 2]);
      if (o[0] > 0.9 && Math.hypot(o[1], o[2]) < 0.04) { light++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
    };
    for (let x = 0; x < w; x++) { ringPx(x); ringPx((h - 1) * w + x); }
    for (let y = 1; y < h - 1; y++) { ringPx(y * w); ringPx(y * w + w - 1); }
    info.ring = n ? light / n : 0;
    let bg = null;
    if (n && light / n >= 0.5) bg = oklab(sr / light, sg / light, sb / light);
    else if (n > 0.2 * ringN) { info.why = 'ring'; return false; } // no light background to remove (tight crops touch the edge)
    else {
      // on transparency: only worth it when neutral dark ink (wordmark text) would vanish on a dark surface
      let opq = 0, ink = 0;
      for (let p = 0, P = w * h; p < P; p++) {
        const i = p * 4;
        if (d[i + 3] < 128) continue;
        opq++;
        const o = oklab(d[i], d[i + 1], d[i + 2]);
        if (o[0] < 0.5 && Math.hypot(o[1], o[2]) < 0.05) ink++;
      }
      info.ink = opq ? ink / opq : 0;
      if (!opq || ink / opq < 0.08) { info.why = 'no-ink'; return false; }
    }
    const cache = new Map();
    for (let p = 0, P = w * h; p < P; p++) {
      const i = p * 4;
      if (!d[i + 3]) continue;
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      let r = cache.get(key);
      if (!r) {
        const o = oklab(d[i], d[i + 1], d[i + 2]);
        const dist = bg ? Math.hypot(o[0] - bg[0], o[1] - bg[1], o[2] - bg[2]) : 1;
        const cov = bg ? Math.max(0, Math.min(1, (dist - 0.03) / 0.22)) : 1; // 0 = background, 1 = ink, between = anti-aliased edge
        if (cov <= 0) r = [0, 0, 0, 0];
        else {
          // unmix the edge pixel from the background, then restyle the ink for a dark surface
          let L = bg ? (o[0] - (1 - cov) * bg[0]) / cov : o[0], a = bg ? (o[1] - (1 - cov) * bg[1]) / cov : o[1], b = bg ? (o[2] - (1 - cov) * bg[2]) / cov : o[2];
          L = Math.max(0, Math.min(1, L));
          const C = Math.hypot(a, b);
          if (C < 0.05) L = 0.94 - 0.75 * L;                       // black/gray ink -> light
          else if (L < 0.62) { L = 0.62 + 0.15 * L / 0.62; a *= 0.92; b *= 0.92; } // brand colour: same hue, lifted to read on dark
          const rgb = toRgb(L, a, b);
          r = [rgb[0], rgb[1], rgb[2], cov];
        }
        cache.set(key, r);
      }
      d[i] = r[0]; d[i + 1] = r[1]; d[i + 2] = r[2]; d[i + 3] = Math.round(d[i + 3] * r[3]);
    }
    return true;
  }
  // blob -> data URL of the adapted image at its natural size (so layout never shifts), or null
  async function sniffType(blob) {
    const h = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const txt = String.fromCharCode(...h);
    if (h[0] === 0x89 && txt.slice(1, 4) === 'PNG') return 'image/png';
    if (h[0] === 0xff && h[1] === 0xd8) return 'image/jpeg';
    if (txt.startsWith('GIF8')) return 'image/gif';
    if (txt.startsWith('RIFF') && txt.slice(8, 12) === 'WEBP') return 'image/webp';
    if (/<svg|<\?xml/i.test(txt)) return 'image/svg+xml';
    return blob.type;
  }
  async function adaptImage(blob, info) {
    info = info || {};
    const type = await sniffType(blob); // servers mislabel images (e.g. video/webp)
    if (type !== blob.type) blob = new Blob([blob], {type});
    let src = null;
    if (!/svg/.test(blob.type)) { try { src = await createImageBitmap(blob); } catch (e) { src = null; } }
    if (!src) {
      const u = URL.createObjectURL(blob.type ? blob : new Blob([blob], {type: 'image/svg+xml'}));
      src = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = u; });
      URL.revokeObjectURL(u);
    }
    if (!src) { info.why = 'decode'; return null; }
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    if (!w || !h || w * h > 2400 * 2400) { info.why = 'size'; return null; }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', {willReadFrequently: true});
    ctx.drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    const im = ctx.getImageData(0, 0, w, h);
    if (!adaptPixels(im.data, w, h, info)) return null;
    ctx.putImageData(im, 0, 0);
    return c.toDataURL('image/png');
  }

  globalThis.NadirMap = NadirMap;
  globalThis.NadirAdaptImage = adaptImage;
  globalThis.NadirImageCSS = TREAT_CSS;
})();
