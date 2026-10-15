// Nadir page analyzer. Shared by the training crawler (Playwright) and the browser extension.
// Defines globalThis.__nadirExtract(opts) -> Promise<PageDescription>.
// Everything the model sees is computed here, so training and inference features match exactly.
(function () {
  'use strict';
  if (globalThis.__nadirExtract) return;

  const ROLES = ['bg', 'text', 'border', 'shadow', 'gradient', 'fill', 'stroke'];
  const R = Object.fromEntries(ROLES.map((r, i) => [r, i]));
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM']);
  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL']);
  const FORM = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
  const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const CODE = new Set(['CODE', 'PRE', 'KBD', 'SAMP']);
  const SVG_SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use', 'g', 'svg']);

  // ---------- color parsing ----------
  const colorCache = new Map();
  let cctx = null;
  const BAD_COLOR = /var\(|env\(|attr\(|calc\(|^(inherit|initial|unset|revert|revert-layer|currentcolor|auto|none|transparent|-webkit-[\w-]+|-moz-[\w-]+)$/i;
  function splitTop(s) { // split on top-level commas
    const out = []; let depth = 0, cur = '';
    for (const ch of s) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out.map(x => x.trim());
  }
  function canvasParse(str) {
    const ld = str.match(/^light-dark\((.*)\)$/i);
    if (ld) { const parts = splitTop(ld[1]); return parts.length === 2 ? parseColor(parts[0]) : null; }
    if (BAD_COLOR.test(str)) return null;
    if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', str)) return null;
    if (!cctx) {
      const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(1, 1) : Object.assign(document.createElement('canvas'), {width: 1, height: 1});
      cctx = c.getContext('2d', {willReadFrequently: true});
    }
    cctx.fillStyle = '#010203';
    const before = cctx.fillStyle;
    cctx.fillStyle = str;
    if (cctx.fillStyle === before && !/^#?010203/i.test(str)) return null; // canvas rejected it
    cctx.clearRect(0, 0, 1, 1);
    cctx.fillRect(0, 0, 1, 1);
    const d = cctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  function parseColor(str) {
    if (!str) return null;
    let c = colorCache.get(str);
    if (c !== undefined) return c;
    c = null;
    const s = str.trim();
    if (s === 'transparent' || s === 'none' || s === '' || s.startsWith('url(') || s === 'currentcolor') c = null;
    else {
      const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
      if (m) {
        let a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        c = [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3]), a];
      } else {
        try { c = canvasParse(s); } catch (e) { c = null; }
      }
      if (c && c[3] <= 0.004) c = null;
    }
    colorCache.set(str, c);
    return c;
  }
  // all colors inside a composite value (box-shadow, gradients)
  const COLOR_RE = /(rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}\b)/g;
  function colorsIn(str) {
    if (!str || str === 'none') return [];
    const out = [];
    for (const m of str.matchAll(COLOR_RE)) { const c = parseColor(m[1]); if (c) out.push(c); }
    return out;
  }
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const keyOf = (c) => hex2(c[0]) + hex2(c[1]) + hex2(c[2]) + hex2(Math.round(c[3] * 255));

  // sRGB -> OKLab
  function lin(u) { u /= 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); }
  function oklab(c) {
    const r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function relLum(c) { return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); }
  function over(top, bottom) { // composite rgba over opaque rgb
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  }

  // ---------- dark-mode support scan ----------
  const DARK_SEL_RE = /(?:^|[\s,>+~(])((?:html|body|:root)?(?:\.(?:[\w-]*-)?dark(?:-[\w-]+)?|\.(?:[\w-]*-)?night[\w-]*|\[data-[\w-]*(?:theme|mode|scheme|color-mode|appearance)[\w-]*(?:[~|^*$]?=\s*["']?[\w-]*dark[\w-]*["']?)\s*(?:i\s*)?\]|\[(?:theme|mode)\s*=\s*["']?dark["']?\]|\[dark(?:-theme|-mode)?\]))/i;
  function scanSheets(limitRules) {
    const res = {sheets: 0, blocked: 0, rules: 0, darkMediaRules: 0, darkMediaColorDecls: 0, lightMediaRules: 0,
      darkSelectors: {}, ruleColors: [], hoverColors: 0};
    let budget = limitRules;
    const seenRuleColors = new Map();
    const pushRuleColor = (role, c, state) => {
      const k = role + ':' + keyOf(c);
      const e = seenRuleColors.get(k);
      if (e) { e.n++; if (state) e.state++; return; }
      seenRuleColors.set(k, {role, c, n: 1, state: state ? 1 : 0});
    };
    function walk(rules, inDarkMedia, inLightMedia) {
      for (const rule of rules) {
        if (budget-- <= 0) return;
        if (rule.cssRules && rule.media) {
          const mt = rule.media.mediaText || '';
          const dark = /prefers-color-scheme\s*:\s*dark/i.test(mt);
          const light = /prefers-color-scheme\s*:\s*light/i.test(mt);
          if (dark) res.darkMediaRules++;
          if (light) res.lightMediaRules++;
          walk(rule.cssRules, inDarkMedia || dark, inLightMedia || light);
          continue;
        }
        if (rule.cssRules && !rule.style) { walk(rule.cssRules, inDarkMedia, inLightMedia); continue; }
        if (!rule.style) continue;
        res.rules++;
        const st = rule.style;
        let colorDecls = 0;
        const sel = rule.selectorText || '';
        const state = /:(hover|focus|active|focus-visible|focus-within|checked)/.test(sel);
        for (let i = 0; i < st.length; i++) {
          const p = st[i];
          const v = st.getPropertyValue(p);
          if (!v) continue;
          let role = -1;
          if (p === 'background-color' || p === 'background') role = R.bg;
          else if (p === 'color' || p === '-webkit-text-fill-color') role = R.text;
          else if (p.startsWith('border') && p.endsWith('color') || p === 'outline-color') role = R.border;
          else if (p === 'fill') role = R.fill;
          else if (p === 'stroke') role = R.stroke;
          else if (p === 'box-shadow' || p === 'text-shadow') role = R.shadow;
          else if (p === 'background-image') role = R.gradient;
          else if (p.startsWith('--')) { if (COLOR_RE.test(v)) colorDecls++; COLOR_RE.lastIndex = 0; continue; }
          if (role < 0) continue;
          colorDecls++;
          if (inDarkMedia || inLightMedia) continue; // light page colors only
          const cs = (role === R.shadow || role === R.gradient || p === 'background') ? colorsIn(v) : [parseColor(v)].filter(Boolean);
          for (const c of cs) { pushRuleColor(role === R.gradient && p === 'background' ? R.bg : role, c, state); if (state) res.hoverColors++; }
        }
        if (inDarkMedia) res.darkMediaColorDecls += colorDecls;
        if (colorDecls && sel) {
          const m = sel.match(DARK_SEL_RE);
          if (m) {
            const k = m[1].trim();
            res.darkSelectors[k] = (res.darkSelectors[k] || 0) + colorDecls;
          }
        }
      }
    }
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || []), ...(scanSheets.extra || [])];
    for (const sh of sheets) {
      if (scanSheets.filter && !scanSheets.filter(sh)) continue;
      res.sheets++;
      let rules;
      try { rules = sh.cssRules; } catch (e) { res.blocked++; continue; }
      if (!rules) { res.blocked++; continue; }
      walk(rules, sh.media && /prefers-color-scheme\s*:\s*dark/i.test(sh.media.mediaText || ''), false);
    }
    res.ruleColors = [...seenRuleColors.values()];
    return res;
  }

  function schemeInfo(sheetScan) {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const rootCS = getComputedStyle(document.documentElement).colorScheme || '';
    const darkLinks = [...document.querySelectorAll('link[rel~="stylesheet"][media]')].filter(l => /prefers-color-scheme\s*:\s*dark/i.test(l.media)).length;
    const darkSources = [...document.querySelectorAll('picture source[media]')].filter(s => /prefers-color-scheme\s*:\s*dark/i.test(s.media)).length;
    const html = document.documentElement, body = document.body;
    const attrs = {};
    for (const el of [html, body]) {
      if (!el) continue;
      for (const a of el.attributes) if (/theme|mode|scheme|appearance|dark|light/i.test(a.name + '=' + a.value) && a.name !== 'style') attrs[el.tagName.toLowerCase() + '@' + a.name] = a.value.slice(0, 80);
    }
    const sel = Object.entries(sheetScan.darkSelectors).sort((a, b) => b[1] - a[1]).slice(0, 12);
    return {
      metaColorScheme: meta ? meta.content : null,
      rootColorScheme: rootCS,
      darkMediaRules: sheetScan.darkMediaRules,
      darkMediaColorDecls: sheetScan.darkMediaColorDecls,
      lightMediaRules: sheetScan.lightMediaRules,
      darkLinks, darkSources,
      darkSelectors: sel,
      rootAttrs: attrs,
      rootClass: (html.className && typeof html.className === 'string' ? html.className : '').slice(0, 200),
      bodyClass: (body && typeof body.className === 'string' ? body.className : '').slice(0, 200),
      sheets: sheetScan.sheets, blockedSheets: sheetScan.blocked, rules: sheetScan.rules,
    };
  }

  // ---------- ads ----------
  // Ad slots are ignored entirely, so a page looks the same to the model with or without an ad blocker.
  const AD_TOKEN = /^(ad|ads|adv|advert|adverts|advertisement|advertising|adsbygoogle|adslot|adunit|adbox|adblock|adbanner|ad[-_](slot|unit|container|wrapper|banner|box|block|placeholder|label|space|zone|frame|holder|area|leaderboard|rail|sidebar|top|bottom|inline|native|mpu|billboard|skyscraper|sticky)|(top|side|bottom|inline|sticky|native|header|footer|right|left)[-_]?ads?|banner[-_]?ads?|gpt[-_]ad.*|dfp[-_]?ad.*|google[-_]ads?.*|taboola.*|trc_.*|outbrain.*|ob[-_]widget.*|sponsored([-_].*)?|promoted[-_]?(content|post|ad)s?|mgid.*|revcontent.*|teads.*|criteo.*|amzn[-_]?ad.*|adthrive.*|ezoic.*|mediavine.*)$/i;
  const AD_ID = /^(google_ads|div-gpt-ad|gpt-ad|ad[-_]|ads[-_]|taboola|outbrain|adthrive|ezoic-pub-ad|mgid|revcontent)/i;
  const AD_SRC = /(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google|amazon-adsystem\.com|adnxs\.com|taboola\.com|outbrain\.com|criteo\.|pubmatic\.com|rubiconproject\.com|openx\.net|adsrvr\.org|moatads\.com|mgid\.com|revcontent\.com|teads\.tv|media\.net\/|ezoic|adthrive|mediavine)/i;
  function isAd(el) {
    const tag = el.tagName;
    if (tag === 'INS' && /adsbygoogle/.test(el.className || '')) return true;
    if ((tag === 'IFRAME' || tag === 'IMG' || tag === 'A') && AD_SRC.test(el.getAttribute('src') || el.getAttribute('href') || '')) return true;
    if (el.hasAttribute('data-ad-slot') || el.hasAttribute('data-google-query-id') || el.hasAttribute('data-ad-unit') || el.hasAttribute('data-adunit') || el.hasAttribute('data-ad-client')) return true;
    const id = el.id;
    if (id && typeof id === 'string' && AD_ID.test(id)) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls) { for (const c of cls.split(/\s+/)) if (c && AD_TOKEN.test(c)) return true; }
    const al = el.getAttribute('aria-label');
    if (al && /^(advertisement|ad|sponsored|anzeige|publicidad|publicité|pubblicità|реклама|広告)$/i.test(al.trim())) return true;
    return false;
  }

  // ---------- element walk ----------
  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id && typeof el.id === 'string') s += '#' + el.id.slice(0, 24);
    const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
    if (cls) s += '.' + cls.trim().split(/\s+/).slice(0, 3).join('.').slice(0, 48);
    return s;
  }
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    t = t.replace(/\s+/g, ' ').trim();
    if (!t && FORM.has(el.tagName)) {
      const v = el.value || el.placeholder || '';
      if (el.type !== 'hidden' && el.type !== 'checkbox' && el.type !== 'radio') t = String(v).slice(0, 60) || ' ';
    }
    return t;
  }

  // The part of a CSS background image that is shown, in CSS px: [x, y, w, h, displayed image w, h] (0 = natural size).
  // Only plain px positions/sizes (icon sprites); keyword/percentage layouts show the whole image.
  function bgCrop(cs, w, h) {
    const pos = (cs.backgroundPosition || '').split(',')[0].trim().split(/\s+/);
    const size = (cs.backgroundSize || 'auto').split(',')[0].trim().split(/\s+/);
    if (pos.length !== 2 || !pos.every(v => /^-?[\d.]+px$/.test(v))) return null;
    const px = parseFloat(pos[0]), py = parseFloat(pos[1]);
    let sw = 0, sh = 0;
    if (size.length === 2 && size.every(v => /^[\d.]+px$/.test(v))) { sw = parseFloat(size[0]); sh = parseFloat(size[1]); }
    else if (size.length === 1 && /^[\d.]+px$/.test(size[0])) { sw = parseFloat(size[0]); sh = -1; } // height follows the aspect ratio
    else if (!(size.length === 1 && size[0] === 'auto') && !(size.length === 2 && size[0] === 'auto' && size[1] === 'auto')) return null;
    if (px >= 0 && py >= 0) return null; // drawn from its corner: the whole image (or a texture) is shown
    return [Math.round(-px), Math.round(-py), Math.round(w), Math.round(h), sw, sh];
  }

  async function extract(opts) {
    opts = Object.assign({maxElements: 5000, maxRules: 40000, maxTokens: 384, maxImages: 48, describe: false,
      thumbs: false, thumbSize: 32, bigThumbSize: 0, fetchImage: null, pseudo: true, time: true,
      srcMax: 600}, opts || {}); // crawl records keep 600 chars of a URL; the extension needs whole data: URLs to decode them
    const t0 = performance.now();
    const vw = innerWidth, vh = innerHeight;
    const sx = scrollX, sy = scrollY;
    const docEl = document.documentElement;
    const docH = Math.max(docEl.scrollHeight, document.body ? document.body.scrollHeight : 0, vh);
    const docW = Math.max(vw, Math.min(docEl.scrollWidth, vw * 1.5));
    const pageArea = docW * Math.min(docH, vh * 8);
    scanSheets.filter = opts.sheetFilter || null;
    scanSheets.extra = opts.extraSheets || [];
    const sheetScan = scanSheets(opts.maxRules);

    // canvas default background (white unless the page opts into dark color-scheme)
    const rootCS = getComputedStyle(docEl);
    const canvasDark = /dark/.test(rootCS.colorScheme) && !/light/.test(rootCS.colorScheme);
    const canvasColor = canvasDark ? [18, 18, 18, 1] : [255, 255, 255, 1];

    const tokens = new Map(); // key role:hex -> token
    function tok(role, c) {
      const k = role + ':' + keyOf(c);
      let t = tokens.get(k);
      if (!t) {
        t = {k, role, c, i: -1, area: 0, area1: 0, n: 0, nVis: 0, chars: 0, fsSum: 0, fsMax: 0, bold: 0, root: 0,
          inter: 0, link: 0, head: 0, code: 0, form: 0, header: 0, footer: 0, nav: 0, under: [0, 0, 0, 0], over: [0, 0, 0, 0],
          contrastSum: 0, contrastW: 0, rules: 0, state: 0, depthSum: 0, ex: [], xs: 0, ys: 0, ws: 0, hs: 0, imgUnder: 0, fixed: 0, media: 0};
        tokens.set(k, t);
      }
      return t;
    }
    const rel = new Map(); // "type|a|b" -> weight
    function addRel(type, a, b, w) {
      if (!a || !b || a === b) return;
      const k = type + '|' + a.k + '|' + b.k;
      rel.set(k, (rel.get(k) || 0) + w);
    }

    // walk DOM (including open shadow roots) in document order
    let adsSkipped = 0;
    const els = [];
    const stack = document.body ? [document.body] : [];
    const deferred = [];
    const parentOf = new Map();
    while ((stack.length || deferred.length) && els.length < opts.maxElements) {
      const el = stack.length ? stack.pop() : deferred.shift();
      els.push(el);
      if (el !== document.body && el.getClientRects().length === 0 && !(el instanceof SVGElement)) {
        // hidden subtree (display:none etc.): visit later, only if budget remains
        const kids = [...el.children].filter(k => !SKIP_TAGS.has(k.tagName) && !isAd(k));
        for (const k of kids) { parentOf.set(k, el); deferred.push(k); }
        continue;
      }
      const kids = [];
      const root = el.shadowRoot || null;
      if (root) for (const k of root.children) kids.push(k);
      for (const k of el.children) kids.push(k);
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (SKIP_TAGS.has(k.tagName)) continue;
        if (isAd(k)) { adsSkipped++; continue; }
        parentOf.set(k, el);
        stack.push(k);
      }
    }

    // media (video players, embeds, canvases, large images): overlays on these must keep their colours
    const media = [];
    for (const m of document.querySelectorAll('video, iframe, canvas, embed, object, img')) {
      if (m.tagName === 'IFRAME' && AD_SRC.test(m.src || '')) continue;
      const r = m.getBoundingClientRect();
      if (r.width * r.height < (m.tagName === 'IMG' ? 40000 : 6000)) continue;
      media.push({m, x: r.left + sx, y: r.top + sy, w: r.width, h: r.height});
      if (media.length > 64) break;
    }
    const onMedia = (el, x, y, w, h) => {
      if (!media.length || w * h <= 0) return 0;
      for (const md of media) {
        if (md.m === el) continue;
        if (el.contains(md.m) && w * h < md.w * md.h * 2.5) return 1;   // player/media container
        const ix = Math.max(0, Math.min(x + w, md.x + md.w) - Math.max(x, md.x));
        const iy = Math.max(0, Math.min(y + h, md.y + md.h) - Math.max(y, md.y));
        if (ix * iy >= 0.6 * w * h) return 1;                            // drawn on top of media
      }
      return 0;
    };
    // per-element info
    const info = new Map();
    const htmlBg = parseColor(rootCS.backgroundColor);
    const bodyCS = document.body ? getComputedStyle(document.body) : null;
    const bodyBg = bodyCS ? parseColor(bodyCS.backgroundColor) : null;
    // effective root surface: body bg propagates to canvas if html has none
    let rootSurface = htmlBg ? over(htmlBg, canvasColor) : (bodyBg ? over(bodyBg, canvasColor) : canvasColor);
    const rootTok = tok(R.bg, htmlBg || bodyBg || canvasColor);
    rootTok.root = 1;
    rootTok.n++; rootTok.nVis++;
    const rootRec = {surf: rootSurface, surfTok: rootTok, imgBg: false, region: 0, depth: 0, fixed: false};
    const images = [];
    const svgRoots = [];
    // an image drawn with `content: url(...)` in ::before/::after (icon fonts' image cousins, sprite icons)
    function pseudoImage(el, parent, pseudo, ct, rect, x, y, area1, rec, vis) {
      const pu = ct && /^url\(\s*["']?([^"')]+)["']?\s*\)/.exec(ct);
      if (!pu) return;
      let bx = x, by = y, bw = rect.width, bh = rect.height, cropPx = null;
      const pe = parent && !(parent instanceof SVGElement) ? parent : null;
      if ((bw > 72 || bh > 72) && pe) { // one icon of a sprite sheet: the element is shifted inside a small clipping box
        const prc = pe.getBoundingClientRect();
        if (prc.width <= 72 && prc.height <= 72 && prc.width >= 4 && prc.height >= 4 && getComputedStyle(pe).overflow !== 'visible') {
          cropPx = [Math.round(prc.left + sx - x), Math.round(prc.top + sy - y), Math.round(prc.width), Math.round(prc.height), 0, 0];
          bx = prc.left + sx; by = prc.top + sy; bw = prc.width; bh = prc.height;
        }
      }
      if (!cropPx && !vis) return;
      if (bw * bh <= 16 || bw > 400 || bh > 400) return;
      try { images.push({el, kind: 'pseudo', src: new URL(pu[1], location.href).href, x: bx, y: by, w: bw, h: bh, area: bw * bh, area1: Math.min(area1 || bw * bh, bw * bh), rec, cropPx, pseudo}); } catch (e) {}
    }
    let visibleCount = 0;

    const ec = opts.elemColors ? [] : null;
    for (const el of els) {
      const cs = getComputedStyle(el);
      const ecRow = ec ? [el.tagName, 0, null, null, null, null, null, null, null] : null;
      if (ec) ec.push(ecRow);
      const parent = parentOf.get(el);
      const p = parent ? info.get(parent) : rootRec;
      const pr = p || rootRec;
      if (cs.display === 'none') { info.set(el, Object.assign({}, pr, {hidden: true})); }
      const hidden = cs.display === 'none' || (pr && pr.hidden) || cs.visibility === 'hidden' || cs.opacity === '0';
      const rect = el.getBoundingClientRect();
      const x = rect.left + sx, y = rect.top + sy;
      const w = Math.max(0, Math.min(rect.width, docW - Math.max(0, x)));
      const h = Math.max(0, rect.height);
      const vis = !hidden && w > 1 && h > 1 && x + w > 0 && y + h > 0;
      const area = vis ? Math.min(w * h, docW * docH) : 0;
      const area1 = vis ? Math.max(0, Math.min(x + w, vw) - Math.max(x, 0)) * Math.max(0, Math.min(y + h, vh) - Math.max(y, 0)) : 0;
      if (vis) visibleCount++;
      if (ecRow) ecRow[1] = Math.round(area);
      const tag = el.tagName;
      const isSvg = el instanceof SVGElement;
      // regions
      let region = pr.region;
      if (tag === 'HEADER' || el.getAttribute && el.getAttribute('role') === 'banner') region |= 1;
      if (tag === 'NAV' || el.getAttribute && el.getAttribute('role') === 'navigation') region |= 2;
      if (tag === 'FOOTER' || el.getAttribute && el.getAttribute('role') === 'contentinfo') region |= 4;
      const fixed = pr.fixed || cs.position === 'fixed' || cs.position === 'sticky';
      const om = vis ? onMedia(el, x, y, w, h) : 0;
      const rec = {surf: pr.surf, surfTok: pr.surfTok, imgBg: pr.imgBg, region, depth: pr.depth + 1, hidden: hidden, fixed, om,
        inLink: pr.inLink || tag === 'A', link: tag === 'A' ? el : pr.link};
      info.set(el, rec);
      const flags = (t) => {
        t.n++;
        if (vis) { t.nVis++; t.depthSum += rec.depth; }
        if (INTERACTIVE.has(tag) || el.getAttribute && el.getAttribute('role') === 'button') t.inter++;
        if (rec.inLink) t.link++;
        if (HEADINGS.has(tag)) t.head++;
        if (CODE.has(tag)) t.code++;
        if (FORM.has(tag)) t.form++;
        if (region & 1) t.header++;
        if (region & 2) t.nav++;
        if (region & 4) t.footer++;
        if (fixed) t.fixed++;
        if (om) t.media++;
        if (opts.describe && t.ex.length < 3 && vis) {
          const txt = ownText(el);
          t.ex.push(describe(el) + (txt ? ' "' + txt.slice(0, 40) + '"' : ''));
        }
      };

      // background
      const bg = parseColor(cs.backgroundColor);
      const bgImg = cs.backgroundImage;
      if (bg) {
        const t = tok(R.bg, bg);
        if (ecRow) ecRow[2] = keyOf(bg);
        flags(t);
        t.area += area; t.area1 += area1;
        if (vis) { t.xs += x * area; t.ys += y * area; t.ws += w * area; t.hs += h * area; }
        const under = pr.surf;
        if (vis) { addRel('bb', t, pr.surfTok, area); }
        const ul = oklab(under);
        t.under[0] += ul[0] * (area + 1); t.under[1] += ul[1] * (area + 1); t.under[2] += ul[2] * (area + 1); t.under[3] += area + 1;
        if (pr.imgBg) t.imgUnder += 1;
        rec.surf = over(bg, under);
        rec.surfTok = t;
        rec.surfEl = el;
        rec.ownArea = area;
      }
      if (bgImg && bgImg !== 'none') {
        if (bgImg.includes('gradient')) {
          if (ecRow) ecRow[7] = colorsIn(bgImg).map(keyOf).join(',');
          for (const c of colorsIn(bgImg)) { const t = tok(R.gradient, c); flags(t); t.area += area / 2; t.area1 += area1 / 2; }
          const gc = colorsIn(bgImg);
          if (gc.length) {
            let avg = [0, 0, 0, 1];
            for (const c of gc) { const o = over(c, pr.surf); avg[0] += o[0] / gc.length; avg[1] += o[1] / gc.length; avg[2] += o[2] / gc.length; }
            rec.surf = avg; rec.imgBg = false;
          }
        }
        const urls = [...bgImg.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(m => m[1]);
        if (urls.length && vis && area > 64) {
          images.push({el, kind: 'bg', src: urls[0], x, y, w, h, area, area1, rec, cropPx: bgCrop(cs, w, h)});
          if (area > 0.02 * vw * vh) rec.imgBg = true;
        }
      }
      if (ecRow) ecRow[8] = keyOf(rec.surf.map((v, i) => i < 3 ? Math.round(v) : 1));
      // text
      const txt = ownText(el);
      if (txt) {
        const col = parseColor(cs.color);
        if (col) {
          const t = tok(R.text, col);
          if (ecRow) ecRow[3] = keyOf(col);
          flags(t);
          const n = txt.length;
          t.chars += vis ? n : 0;
          const fs = parseFloat(cs.fontSize) || 16;
          t.fsSum += fs * n; t.fsMax = Math.max(t.fsMax, vis ? fs : 0);
          if ((parseInt(cs.fontWeight) || 400) >= 600) t.bold += n;
          t.area += vis ? Math.min(area, n * fs * fs * 0.5) : 0;
          t.area1 += area1 ? Math.min(area1, n * fs * fs * 0.5) : 0;
          const under = rec.surf;
          const ul = oklab(under);
          const wgt = vis ? n : 0.1;
          t.under[0] += ul[0] * wgt; t.under[1] += ul[1] * wgt; t.under[2] += ul[2] * wgt; t.under[3] += wgt;
          const fg = over(col, under);
          const l1 = relLum(fg), l2 = relLum(under);
          t.contrastSum += ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * wgt; t.contrastW += wgt;
          if (rec.imgBg) t.imgUnder += 1;
          if (vis) addRel('tb', t, rec.surfTok, n);
          // reverse: text sitting on this surface
          const st = rec.surfTok;
          const tl = oklab(col);
          st.over[0] += tl[0] * wgt; st.over[1] += tl[1] * wgt; st.over[2] += tl[2] * wgt; st.over[3] += wgt;
          if (bg) addRel('se', t, tok(R.bg, bg), n);
        }
      }
      // borders
      if (!isSvg) {
        const seen = new Set();
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
          const bw = parseFloat(cs['border' + side + 'Width']);
          if (!bw || cs['border' + side + 'Style'] === 'none' || cs['border' + side + 'Style'] === 'hidden') continue;
          const bc = parseColor(cs['border' + side + 'Color']);
          if (!bc) continue;
          const k = keyOf(bc);
          const len = (side === 'Top' || side === 'Bottom') ? w : h;
          if (seen.has(k)) { const t = tok(R.border, bc); t.area += vis ? bw * len : 0; continue; }
          seen.add(k);
          if (ecRow && !ecRow[4]) ecRow[4] = k;
          const t = tok(R.border, bc);
          flags(t);
          t.area += vis ? bw * len : 0;
          const ul = oklab(pr.surf);
          t.under[0] += ul[0]; t.under[1] += ul[1]; t.under[2] += ul[2]; t.under[3] += 1;
          if (vis) addRel('rb', t, pr.surfTok, bw * len);
          if (bg) addRel('se', t, tok(R.bg, bg), 1);
        }
        const ow = parseFloat(cs.outlineWidth);
        if (ow && cs.outlineStyle !== 'none') {
          const oc = parseColor(cs.outlineColor);
          if (oc) { const t = tok(R.border, oc); flags(t); t.area += vis ? ow * 2 * (w + h) : 0; }
        }
        // shadows
        for (const sh of [cs.boxShadow, cs.textShadow]) {
          if (!sh || sh === 'none') continue;
          for (const c of colorsIn(sh)) { const t = tok(R.shadow, c); flags(t); t.area += vis ? Math.min(area, 2 * (w + h) * 4) : 0;
            const ul = oklab(pr.surf); t.under[0] += ul[0]; t.under[1] += ul[1]; t.under[2] += ul[2]; t.under[3] += 1; }
        }
      }
      // svg paint
      if (isSvg) {
        const ltag = tag.toLowerCase();
        if (ltag === 'svg' && !(parent instanceof SVGElement) && vis && area >= 400) {
          const meta = ((el.getAttribute('class') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + ((el.querySelector('title') || {}).textContent || '')).toLowerCase();
          const useExt = [...el.querySelectorAll('use')].some(u => { const h = u.getAttribute('href') || u.getAttribute('xlink:href') || ''; return h && !h.startsWith('#'); });
          if (rec.inLink || (region & 1) || /logo|brand|wordmark/.test(meta) || useExt || area >= 4000)
            images.push({el, kind: 'svg', src: '', x, y, w, h, area, area1, rec, svgMeta: meta, useExt});
        }
        if (SVG_SHAPES.has(ltag) && ltag !== 'svg' && ltag !== 'g') {
          const fc = cs.fill && cs.fill.startsWith('url') ? null : parseColor(cs.fill);
          const sc = cs.stroke && cs.stroke.startsWith('url') ? null : parseColor(cs.stroke);
          const sw = parseFloat(cs.strokeWidth) || 0;
          const fo = parseFloat(cs.fillOpacity); const so = parseFloat(cs.strokeOpacity);
          if (ecRow && fc) ecRow[5] = keyOf(fc);
          if (ecRow && sc) ecRow[6] = keyOf(sc);
          if (fc && fo !== 0) { const t = tok(R.fill, fc); flags(t); t.area += area * 0.5; t.area1 += area1 * 0.5;
            const ul = oklab(rec.surf); t.under[0] += ul[0]; t.under[1] += ul[1]; t.under[2] += ul[2]; t.under[3] += 1; if (vis) addRel('tb', t, rec.surfTok, Math.sqrt(area + 1)); }
          if (sc && sw > 0 && so !== 0) { const t = tok(R.stroke, sc); flags(t); t.area += vis ? sw * (w + h) : 0;
            const ul = oklab(rec.surf); t.under[0] += ul[0]; t.under[1] += ul[1]; t.under[2] += ul[2]; t.under[3] += 1; if (vis) addRel('tb', t, rec.surfTok, Math.sqrt(area + 1)); }
        }
      }
      // images
      if (tag === 'IMG' && vis && area > 16) {
        images.push({el, kind: 'img', src: el.currentSrc || el.src, x, y, w, h, area, area1, rec});
      } else if ((tag === 'IMAGE' || tag === 'image') && vis) {
        const href = el.getAttribute('href') || el.getAttribute('xlink:href');
        if (href) images.push({el, kind: 'svgimage', src: new URL(href, location.href).href, x, y, w, h, area, area1, rec});
      }
      // sprite-sheet icons whose (huge, shifted) element box counts as off-page: only the clipped part shows
      if (opts.pseudo && !vis && !hidden && !isSvg && (rect.width > 72 || rect.height > 72)) {
        for (const pseudo of ['::before', '::after']) pseudoImage(el, parent, pseudo, getComputedStyle(el, pseudo).content, rect, x, y, area1, rec, false);
      }
      // pseudo elements
      if (opts.pseudo && vis && !isSvg && els.length < 20000) {
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(el, pseudo);
          const ct = ps.content;
          if (!ct || ct === 'none' || ct === 'normal') continue;
          const pb = parseColor(ps.backgroundColor);
          const pw = parseFloat(ps.width) || 0, ph = parseFloat(ps.height) || 0;
          const parea = Math.min(area, pw * ph);
          pseudoImage(el, parent, pseudo, ct, rect, x, y, area1, rec, true);
          if (pb) { const t = tok(R.bg, pb); flags(t); t.area += parea; addRel('bb', t, rec.surfTok, parea); }
          if (ct !== '""' && ct !== "''") {
            const pc = parseColor(ps.color);
            if (pc) { const t = tok(R.text, pc); flags(t); t.chars += 1; const ul = oklab(rec.surf); t.under[0] += ul[0]; t.under[1] += ul[1]; t.under[2] += ul[2]; t.under[3] += 1; addRel('tb', t, rec.surfTok, 1); }
          }
          const bw = parseFloat(ps.borderTopWidth) || parseFloat(ps.borderBottomWidth) || parseFloat(ps.borderLeftWidth);
          if (bw) { const bc = parseColor(ps.borderTopColor !== 'rgba(0, 0, 0, 0)' ? ps.borderTopColor : ps.borderBottomColor); if (bc) { const t = tok(R.border, bc); flags(t); t.area += bw * Math.max(pw, ph); } }
          const psh = ps.boxShadow;
          if (psh && psh !== 'none') for (const c of colorsIn(psh)) { const t = tok(R.shadow, c); flags(t); }
          if (ps.backgroundImage && ps.backgroundImage.includes('gradient')) for (const c of colorsIn(ps.backgroundImage)) { const t = tok(R.gradient, c); flags(t); t.area += parea / 2; }
        }
      }
    }

    // own area for surfaces: subtract direct child surfaces
    // (approximation: walk surfaces; area already includes descendants)
    const childSurfArea = new Map();
    for (const el of els) {
      const r = info.get(el);
      if (!r || !r.surfEl || r.surfEl !== el || !r.ownArea) continue;
      // find nearest ancestor surface element
      let p = parentOf.get(el);
      while (p && !(info.get(p) && info.get(p).surfEl === p)) p = parentOf.get(p);
      const key = p || 'root';
      childSurfArea.set(key, (childSurfArea.get(key) || 0) + r.ownArea);
    }
    const ownAreaTok = new Map();
    let rootOwn = Math.max(0, docW * docH - (childSurfArea.get('root') || 0));
    ownAreaTok.set(rootTok, rootOwn);
    for (const el of els) {
      const r = info.get(el);
      if (!r || r.surfEl !== el || !r.ownArea) continue;
      const own = Math.max(0, r.ownArea - (childSurfArea.get(el) || 0));
      ownAreaTok.set(r.surfTok, (ownAreaTok.get(r.surfTok) || 0) + own);
    }

    // rule-only colors
    for (const rc of sheetScan.ruleColors) {
      const t = tok(rc.role, rc.c);
      t.rules += rc.n; t.state += rc.state;
    }
    // root token area = canvas own area
    rootTok.area += rootOwn;

    // ---------- darkness measurement ----------
    let bgLsum = 0, bgW = 0, darkW = 0;
    for (const [t, own] of ownAreaTok) {
      if (t.role !== R.bg) continue;
      const eff = over(t.c, t.root ? canvasColor : (t.under[3] ? labToApproxRgb(t.under) : canvasColor));
      const L = oklab(eff)[0];
      bgLsum += L * own; bgW += own; if (L < 0.45) darkW += own;
    }
    let txLsum = 0, txW = 0;
    for (const t of tokens.values()) if (t.role === R.text && t.chars) { txLsum += oklab(t.c)[0] * t.chars; txW += t.chars; }
    const darkness = {bgL: bgW ? bgLsum / bgW : 1, darkFrac: bgW ? darkW / bgW : 0, textL: txW ? txLsum / txW : 0, rootL: oklab(rootSurface)[0]};

    // ---------- token selection & features ----------
    let list = [...tokens.values()];
    const score = (t) => (t.root ? 1e12 : 0) + Math.log1p(t.area) * 3 + Math.log1p(t.chars) * 2 + Math.log1p(t.nVis) * 2 + Math.log1p(t.n) + Math.log1p(t.rules) * 0.7 + Math.log1p(t.state);
    list.sort((a, b) => score(b) - score(a));
    const dropped = Math.max(0, list.length - opts.maxTokens);
    list = list.slice(0, opts.maxTokens);
    list.forEach((t, i) => t.i = i);

    // bg lightness rank among visible bg tokens
    const bgVis = list.filter(t => t.role === R.bg && t.area > 0).map(t => oklab(t.c)[0]).sort((a, b) => a - b);
    const rankL = (L) => { if (!bgVis.length) return 0.5; let i = 0; while (i < bgVis.length && bgVis[i] < L) i++; return i / bgVis.length; };
    const totalChars = list.reduce((s, t) => s + (t.role === R.text ? t.chars : 0), 0) || 1;

    const out = [];
    for (const t of list) {
      const lab = oklab(t.c);
      const C = Math.hypot(lab[1], lab[2]);
      const under = t.under[3] ? [t.under[0] / t.under[3], t.under[1] / t.under[3], t.under[2] / t.under[3]] : oklab(canvasColor);
      const overL = t.over[3] ? [t.over[0] / t.over[3], t.over[1] / t.over[3], t.over[2] / t.over[3]] : [0, 0, 0];
      const n = Math.max(1, t.n);
      const own = ownAreaTok.get(t) || 0;
      const f = [
        lab[0], lab[1] * 4, lab[2] * 4, C * 4, t.c[3], C > 0.02 ? lab[1] / C : 0, C > 0.02 ? lab[2] / C : 0,
        t.c[0] / 255, t.c[1] / 255, t.c[2] / 255,
        Math.log1p(t.area / 1000) / 10, Math.sqrt(Math.min(1, t.area / pageArea)), Math.sqrt(Math.min(1, t.area1 / (vw * vh))), Math.sqrt(Math.min(1, own / pageArea)),
        Math.log1p(t.n) / 8, Math.log1p(t.nVis) / 8, Math.log1p(t.rules) / 6, t.rules ? t.state / (t.rules) : 0, (t.n === 0 && t.rules > 0) ? 1 : 0,
        Math.log1p(t.chars) / 10, t.chars / totalChars, t.chars ? (t.fsSum / t.chars) / 32 : 0, t.fsMax / 48, t.chars ? t.bold / t.chars : 0,
        t.root, t.inter / n, t.link / n, t.head / n, t.code / n, t.form / n, t.header / n, t.nav / n, t.footer / n, t.fixed / n,
        under[0], under[1] * 4, under[2] * 4, t.contrastW ? Math.log(t.contrastSum / t.contrastW) / 3 : 0, Math.min(1, t.imgUnder / n),
        overL[0], overL[1] * 4, overL[2] * 4, t.over[3] ? 1 : 0,
        t.role === R.bg ? rankL(lab[0]) : 0, t.nVis ? Math.min(1, t.depthSum / t.nVis / 30) : 0,
        t.ws && t.area ? Math.min(1, t.ws / t.area / docW) : 0, t.hs && t.area ? Math.min(1, t.hs / t.area / vh) : 0,
        t.ys && t.area ? Math.min(1, t.ys / t.area / docH) : 0,
        t.media / n,
      ];
      for (let q = 0; q < f.length; q++) if (!Number.isFinite(f[q])) f[q] = 0; // JSON turns NaN into null; never feed it to the model
      const o = {k: t.k, role: t.role, rgba: [t.c[0], t.c[1], t.c[2], +t.c[3].toFixed(3)], f};
      if (opts.describe) {
        o.d = {area: Math.round(t.area), area1: Math.round(t.area1), own: Math.round(own), n: t.n, nVis: t.nVis, rules: t.rules, state: t.state, chars: t.chars,
          fs: t.chars ? +(t.fsSum / t.chars).toFixed(1) : 0, root: t.root, inter: t.inter, link: t.link, head: t.head, header: t.header, nav: t.nav, footer: t.footer,
          contrast: t.contrastW ? +(t.contrastSum / t.contrastW).toFixed(2) : null, media: t.media, ex: t.ex};
      }
      out.push(o);
    }
    const relOut = [];
    for (const [k, w] of rel) {
      const [type, a, b] = k.split('|');
      const ta = tokens.get(a), tb = tokens.get(b);
      if (!ta || !tb || ta.i < 0 || tb.i < 0) continue;
      relOut.push([['tb', 'bb', 'rb', 'se'].indexOf(type), ta.i, tb.i, +Math.log1p(w).toFixed(3)]);
    }

    // ---------- images ----------
    const imgSeen = new Map();
    let svgCount = 0;
    // logo-like images first, then by area
    const logoish = (im) => (im.rec.link && im.rec.inLink ? 1 : 0) + ((im.rec.region & 1) ? 1 : 0) + (im.kind === 'svg' && /logo|brand/.test(im.svgMeta || '') ? 2 : 0);
    images.sort((a, b) => (logoish(b) - logoish(a)) || (b.area - a.area));
    const imgOut = [];
    for (const im of images) {
      if (imgOut.length >= opts.maxImages) break;
      if (im.kind !== 'svg' && (!im.src || im.src.startsWith('data:image/gif;base64,R0lGOD'))) continue;
      if (im.kind === 'svg') { im.src = 'svg:' + svgCount++; if (opts.markSvg) im.el.setAttribute('data-nadir-svg', im.src); }
      const key = im.src + (im.cropPx ? '#nadir-crop=' + im.cropPx.join(',') : '');
      if (imgSeen.has(key)) { const o = imgOut[imgSeen.get(key)]; o.count++; o.areaSum += im.area; continue; }
      const el = im.el;
      const a = im.rec.link;
      const href = a ? (a.getAttribute('href') || '') : '';
      let homeLink = 0;
      try { if (a) { const u = new URL(href, location.href); homeLink = (u.origin === location.origin && (u.pathname === '/' || u.pathname === '')) ? 1 : 0; } } catch (e) {}
      const meta = im.kind === 'svg' ? (im.svgMeta || '') : ((el.getAttribute && (el.getAttribute('alt') || '')) + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + (im.src.split('?')[0].split('/').pop() || '')).toLowerCase();
      const ext = im.kind === 'svg' ? 'svg' : (im.src.split('?')[0].match(/\.(svg|png|jpe?g|webp|gif|avif|ico)$/i) || [, ''])[1].toLowerCase();
      const under = oklab(im.rec.surf);
      const o = {src: im.src.slice(0, opts.srcMax), kind: im.kind, x: Math.round(im.x), y: Math.round(im.y), w: Math.round(im.w), h: Math.round(im.h), count: 1, areaSum: im.area,
        nw: el.naturalWidth || 0, nh: el.naturalHeight || 0, homeLink, inLink: im.rec.inLink ? 1 : 0, header: (im.rec.region & 3) ? 1 : 0, footer: (im.rec.region & 4) ? 1 : 0,
        logo: /logo|brand|wordmark/.test(meta) ? 1 : 0, icon: /icon|ico\b|glyph|arrow|chevron|caret|svg/.test(meta) ? 1 : 0, avatar: /avatar|profile|user/.test(meta) ? 1 : 0,
        ext, underTok: im.rec.surfTok && im.rec.surfTok.i >= 0 ? im.rec.surfTok.i : -1, under,
        surf: im.rec.surf.slice(0, 3).map(Math.round), vy: Math.round(im.y - sy), vx: Math.round(im.x - sx), useExt: im.useExt ? 1 : 0,
        alt: opts.describe ? ((el.getAttribute && el.getAttribute('alt')) || '').slice(0, 60) : undefined,
        cropPx: im.cropPx || undefined, pseudo: im.pseudo || undefined,
        stats: null, thumb: null};
      if (im.kind === 'img' && el.complete === false) o.loading = 1;
      imgSeen.set(key, imgOut.length);
      imgOut.push(o);
    }
    if (opts.thumbs) await imageStats(imgOut, opts);
    for (const o of imgOut) o.f = imageFeatures(o, vw, vh, docH);
    const res = {
      v: 6, url: location.href, title: document.title.slice(0, 200), vw, vh, docH, docW,
      scheme: schemeInfo(sheetScan), darkness, canvasDark,
      tokens: out, rel: relOut, images: imgOut,
      ec: ec || undefined,
      stats: {ads: adsSkipped, elements: els.length, visible: visibleCount, tokensTotal: tokens.size, tokensDropped: dropped, ms: Math.round(performance.now() - t0)},
    };
    return res;
  }

  function labToApproxRgb(u) {
    // inverse OKLab for averaged under-colour
    const L = u[0] / u[3], a = u[1] / u[3], b = u[2] / u[3];
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    const enc = (x) => { x = Math.max(0, Math.min(1, x)); return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055); };
    return [enc(r), enc(g), enc(bb), 1];
  }

  // ---------- image pixels ----------
  function blobToDataURL(blob) {
    return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
  }
  function loadViaImg(url) {
    return new Promise((res) => {
      const img = new Image(); img.decoding = 'async';
      const done = (ok) => res(ok && img.naturalWidth ? img : null);
      img.onload = () => done(true); img.onerror = () => done(false); setTimeout(() => done(false), 4000);
      img.src = url;
    });
  }
  // Decode without loading a URL into the page where possible (page CSP often blocks blob: images).
  async function loadImage(src, fetchImage) {
    if (fetchImage && !src.startsWith('data:')) {
      const blob = await fetchImage(src);
      if (!blob || !blob.size) return null;
      const isSvg = /svg/.test(blob.type) || /\.svg(\?|#|$)/i.test(src);
      if (!isSvg) { try { return await createImageBitmap(blob); } catch (e) {} }
      const du = await blobToDataURL(isSvg ? new Blob([blob], {type: 'image/svg+xml'}) : blob);
      return du ? await loadViaImg(du) : null;
    }
    return await loadViaImg(src);
  }

  async function imageStats(list, opts) {
    const jobs = list.map(async (o) => {
      try {
        const img = await loadImage(o.src, opts.fetchImage);
        if (!img) return;
        let IW = img.naturalWidth || img.width, IH = img.naturalHeight || img.height, src = img;
        o.nw = o.nw || IW; o.nh = o.nh || IH;
        let crop = null;
        if (o.cropPx) { // one icon of a sprite sheet: measure only the part that is shown
          const [cx, cy, cw, ch, sw, sh] = o.cropPx;
          const kx = sw > 0 ? IW / sw : 1, ky = sh > 0 ? IH / sh : (sh < 0 ? kx : 1);
          crop = [cx * kx, cy * ky, cw * kx, ch * ky];
        } else if (o.cropFrac) { const [fx, fy, fw, fh] = o.cropFrac; crop = [fx * IW, fy * IH, fw * IW, fh * IH]; }
        if (crop) {
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(crop[2])); c.height = Math.max(1, Math.round(crop[3]));
          c.getContext('2d').drawImage(img, crop[0], crop[1], crop[2], crop[3], 0, 0, c.width, c.height);
          src = c; IW = c.width; IH = c.height;
        }
        statsFromSource(o, src, IW, IH, opts);
        if (img.close) img.close();
      } catch (e) { o.err = String(e).slice(0, 80); }
    });
    await Promise.all(jobs);
  }
  function drawThumbSrc(src, iw, ih, size) {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d', {willReadFrequently: true});
    const s = Math.min(size / iw, size / ih);
    const dw = Math.max(1, Math.round(iw * s)), dh = Math.max(1, Math.round(ih * s));
    ctx.drawImage(src, Math.floor((size - dw) / 2), Math.floor((size - dh) / 2), dw, dh);
    return {c, ctx, dw, dh};
  }
  function statsFromSource(o, img, IW, IH, opts) {
    const S = opts.thumbSize;
    const {ctx, dw, dh} = drawThumbSrc(img, IW, IH, S);
    const d = ctx.getImageData(0, 0, S, S).data;
    o.thumb = Array.from(d); // RGBA bytes, letterboxed (transparent pad)
    let n = 0, tr = 0, semi = 0, Ls = 0, L2 = 0, Cs = 0, white = 0, black = 0, ringA = 0, ringL = 0, ringN = 0, total = 0;
    const x0 = Math.floor((S - dw) / 2), y0 = Math.floor((S - dh) / 2);
    const qset = new Set();
    for (let y = y0; y < y0 + dh; y++) for (let x = x0; x < x0 + dw; x++) {
      const i = (y * S + x) * 4; const a = d[i + 3] / 255; total++;
      const ring = (x === x0 || y === y0 || x === x0 + dw - 1 || y === y0 + dh - 1);
      if (ring) { ringA += a; ringN++; }
      if (a < 0.1) { tr++; continue; }
      if (a < 0.9) semi++;
      const lab = oklab([d[i], d[i + 1], d[i + 2]]);
      const C = Math.hypot(lab[1], lab[2]);
      n++; Ls += lab[0]; L2 += lab[0] * lab[0]; Cs += C;
      if (lab[0] > 0.93 && C < 0.03) white++;
      if (lab[0] < 0.3 && C < 0.04) black++;
      if (ring) ringL += lab[0];
      qset.add((d[i] >> 5) << 6 | (d[i + 1] >> 5) << 3 | (d[i + 2] >> 5));
    }
    const mL = n ? Ls / n : 0;
    o.stats = {transp: total ? tr / total : 0, semi: total ? semi / total : 0, meanL: mL, stdL: n ? Math.sqrt(Math.max(0, L2 / n - mL * mL)) : 0,
      meanC: n ? Cs / n : 0, white: n ? white / n : 0, black: n ? black / n : 0, ringA: ringN ? ringA / ringN : 0,
      ringL: ringN ? ringL / Math.max(1, ringN * (ringA / ringN || 1)) : 0, colors: qset.size / 512};
    if (opts.bigThumbSize) o.big = drawThumbSrc(img, IW, IH, opts.bigThumbSize).c.toDataURL('image/png');
  }
  function imageFeatures(o, vw, vh, docH) {
    const s = o.stats || {};
    const ext = o.ext;
    return sanitize([
      Math.log1p(o.w) / 8, Math.log1p(o.h) / 8, Math.log1p(o.areaSum / 100) / 12, Math.min(1, (o.w * o.h) / (vw * vh)), Math.log(Math.max(1, o.w) / Math.max(1, o.h)) / 3,
      Math.log1p(o.nw) / 9, Math.log1p(o.nh) / 9, Math.min(1, o.y / Math.max(1, docH)), o.y < vh ? 1 : 0, Math.log1p(o.count) / 3,
      o.homeLink, o.inLink, o.header, o.footer, o.logo, o.icon, o.avatar,
      ext === 'svg' ? 1 : 0, ext === 'png' ? 1 : 0, (ext === 'jpg' || ext === 'jpeg') ? 1 : 0, ext === 'webp' ? 1 : 0, ext === 'gif' ? 1 : 0, o.kind === 'bg' ? 1 : 0,
      o.under ? o.under[0] : 1, o.under ? o.under[1] * 4 : 0, o.under ? o.under[2] * 4 : 0,
      o.stats ? 1 : 0, s.transp || 0, s.semi || 0, s.meanL || 0, s.stdL || 0, (s.meanC || 0) * 4, s.white || 0, s.black || 0, s.ringA || 0, s.ringL || 0, s.colors || 0,
      o.kind === 'svg' ? 1 : 0, o.useExt || 0,
      o.kind === 'pseudo' ? 1 : 0, o.cropPx ? 1 : 0,
    ]);
  }
  const sanitize = (f) => f.map((v) => (Number.isFinite(+v) ? +v : 0));

  // Compute pixel stats for a list of image entries outside the page (helper page / extension offscreen document).
  // opts.fetchImage(src) -> Blob; opts.shot: dataURL of the viewport screenshot (for inline-SVG crops).
  async function defaultFetch(src) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
    try { const r = await fetch(src, {signal: ac.signal, credentials: 'omit'}); if (!r.ok) return null; const b = await r.blob(); return b.size > 8e6 ? null : b; }
    catch (e) { return null; } finally { clearTimeout(t); }
  }
  async function imageStatsStandalone(list, opts) {
    opts = Object.assign({thumbSize: 32, bigThumbSize: 0, concurrency: 8, fetchImage: defaultFetch}, opts || {});
    let shotImg = null;
    if (opts.shot && list.some(o => o.kind === 'svg')) shotImg = await loadViaImg(opts.shot);
    // inline-SVG crops first (local, fast), then fetched images with limited concurrency
    for (const o of list) {
      if (o.kind !== 'svg' || !shotImg) continue;
      const dpr = opts.dpr || 1;
      if (o.vy < 0 || (o.vy + o.h) * dpr > shotImg.naturalHeight + 1 || o.w < 2 || o.h < 2) continue;
      cropStats(o, shotImg, opts);
    }
    const raster = list.filter(o => o.kind !== 'svg');
    let k = 0;
    const run = async () => { while (k < raster.length) { const o = raster[k++]; await imageStats([o], opts); } };
    await Promise.all(Array.from({length: opts.concurrency}, run));
    return list.map(o => ({stats: o.stats || null, thumb: o.thumb || null, big: o.big || null, nw: o.nw, nh: o.nh, err: o.err}));
  }
  // inline SVGs: crop the rendered element from a screenshot; alpha is keyed off the surface colour beneath it
  function cropStats(o, shot, opts) {
    const S = opts.thumbSize;
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(o.w)); c.height = Math.max(1, Math.round(o.h));
    const cx = c.getContext('2d', {willReadFrequently: true});
    const dpr = opts.dpr || 1;
    cx.drawImage(shot, o.vx * dpr, o.vy * dpr, o.w * dpr, o.h * dpr, 0, 0, c.width, c.height);
    const src = cx.getImageData(0, 0, c.width, c.height);
    const sl = oklab(o.surf || [255, 255, 255]);
    const d = src.data;
    for (let i = 0; i < d.length; i += 4) {
      const lab = oklab([d[i], d[i + 1], d[i + 2]]);
      const dist = Math.hypot(lab[0] - sl[0], lab[1] - sl[1], lab[2] - sl[2]);
      d[i + 3] = Math.round(255 * Math.max(0, Math.min(1, (dist - 0.02) / 0.1)));
    }
    cx.putImageData(src, 0, 0);
    o.nw = c.width; o.nh = c.height;
    statsFromSource(o, c, c.width, c.height, opts);
  }

  // ---------- one image found after the page was analysed (late-loaded, CSS background, sprite or pseudo icon) ----------
  // Same record and features as extract() builds in its walk: the surface under it (backgrounds and gradients of the
  // element and its ancestors composited over the canvas), link/region flags, logo/icon/avatar naming.
  function surfaceOf(el) {
    const chain = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement || (e.getRootNode && e.getRootNode().host) || null) chain.push(e);
    const rootCS = getComputedStyle(document.documentElement);
    const canvasDark = /dark/.test(rootCS.colorScheme) && !/light/.test(rootCS.colorScheme);
    let surf = canvasDark ? [18, 18, 18, 1] : [255, 255, 255, 1];
    for (let i = chain.length - 1; i >= 0; i--) {
      const cs = getComputedStyle(chain[i]);
      const bg = parseColor(cs.backgroundColor);
      if (bg) surf = over(bg, surf);
      const bi = cs.backgroundImage;
      if (bi && bi !== 'none' && bi.includes('gradient')) {
        const gc = colorsIn(bi);
        if (gc.length) {
          const avg = [0, 0, 0, 1];
          for (const c of gc) { const o = over(c, surf); avg[0] += o[0] / gc.length; avg[1] += o[1] / gc.length; avg[2] += o[2] / gc.length; }
          surf = avg;
        }
      }
    }
    return surf;
  }
  function recordFor(el, kind, src, cropPx, box) {
    const vw = innerWidth, vh = innerHeight, sx = scrollX, sy = scrollY;
    const docEl = document.documentElement;
    const docH = Math.max(docEl.scrollHeight, document.body ? document.body.scrollHeight : 0, vh);
    const r = box || el.getBoundingClientRect();
    const x = r.left + sx, y = r.top + sy, w = r.width, h = r.height;
    let region = 0;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const role = e.getAttribute && e.getAttribute('role');
      if (e.tagName === 'HEADER' || role === 'banner') region |= 1;
      if (e.tagName === 'NAV' || role === 'navigation') region |= 2;
      if (e.tagName === 'FOOTER' || role === 'contentinfo') region |= 4;
    }
    const a = el.closest ? el.closest('a') : null;
    let homeLink = 0;
    try { if (a) { const u = new URL(a.getAttribute('href') || '', location.href); homeLink = (u.origin === location.origin && (u.pathname === '/' || u.pathname === '')) ? 1 : 0; } } catch (e) {}
    const meta = (((el.getAttribute && el.getAttribute('alt')) || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + (src.split('?')[0].split('/').pop() || '')).toLowerCase();
    const ext = (src.split('?')[0].match(/\.(svg|png|jpe?g|webp|gif|avif|ico)$/i) || [, ''])[1].toLowerCase();
    const surf = surfaceOf(el);
    return {src, kind, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), count: 1, areaSum: w * h,
      nw: el.naturalWidth || 0, nh: el.naturalHeight || 0, homeLink, inLink: a ? 1 : 0, header: (region & 3) ? 1 : 0, footer: (region & 4) ? 1 : 0,
      logo: /logo|brand|wordmark/.test(meta) ? 1 : 0, icon: /icon|ico\b|glyph|arrow|chevron|caret|svg/.test(meta) ? 1 : 0, avatar: /avatar|profile|user/.test(meta) ? 1 : 0,
      ext, underTok: -1, under: oklab(surf), surf: surf.slice(0, 3).map(Math.round), vy: Math.round(y - sy), vx: Math.round(x - sx), useExt: 0,
      cropPx: cropPx || undefined, stats: null, thumb: null, dims: {vw, vh, docH}};
  }

  globalThis.__nadirImageRecord = recordFor;
  globalThis.__nadirBgCrop = bgCrop;
  globalThis.__nadirImageStats = imageStatsStandalone;
  globalThis.__nadirImageFeatures = imageFeatures;
  globalThis.__nadirExtract = extract;
  globalThis.__nadirOklab = oklab;
  globalThis.__nadirParseColor = parseColor;
})();
