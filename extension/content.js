// Nadir content script (isolated world, document_start, all frames).
// 1. Already dark  -> leave the page alone.
// 2. Has its own dark theme (prefers-color-scheme rules, or a dark class/attribute) -> switch that on.
// 3. Otherwise -> the Nadir model designs a dark palette for this page, applied by the page engine.
(() => {
  'use strict';
  if (window.__nadirContent) return;
  window.__nadirContent = true;

  const isTop = window === window.top;
  const HOST = location.hostname;
  const SKIP_FRAME = /(youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|player\.twitch\.tv|open\.spotify\.com\/embed|w\.soundcloud\.com|google\.[a-z.]+\/maps|maps\.google|doubleclick\.net|googlesyndication|amazon-adsystem|taboola\.com|outbrain\.com|adnxs\.com|criteo|recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|stripe\.com\/v3|js\.stripe\.com|paypal\.com\/sdk|accounts\.google\.com\/gsi)/i;
  if (!/^https?:$/.test(location.protocol)) return;
  if (!isTop && SKIP_FRAME.test(location.href)) return;
  if (document.contentType && !/html|xml/.test(document.contentType)) return;

  const THEME = {mode: 1, brightness: 100, contrast: 100, sepia: 0, grayscale: 0};
  const MODEL_VERSION = 6;
  const SITE_KEY = 'site:' + HOST;
  const DARK_THRESHOLD = (d) => d.bgL < 0.45 && d.darkFrac > 0.6 && (d.textL === 0 || d.textL > 0.55);
  let settings = null, site = null, map = null, drOn = false, treat = {}, svgTreat = {};
  const t0 = performance.now();
  const timing = {};
  const mark = (k) => { timing[k] = Math.round(performance.now() - t0); };
  const send = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }); } catch (e) { res(null); } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n) => new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });

  // ---------------- curtain (hides the light page on the first visit to a site) ----------------
  let curtain = null, curtainTimer = 0;
  function showCurtain() {
    if (!isTop || curtain) return;
    const host = document.createElement('nadir-curtain');
    const sh = host.attachShadow({mode: 'closed'});
    sh.innerHTML = '<style>:host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:#121316;transition:opacity .18s ease;opacity:1}</style>';
    (document.documentElement || document).appendChild(host);
    curtain = host;
    curtainTimer = setTimeout(hideCurtain, 2600); // never hide a page for long
  }
  function hideCurtain() {
    if (!curtain) return;
    const c = curtain; curtain = null; clearTimeout(curtainTimer);
    c.style.opacity = '0';
    setTimeout(() => c.remove(), 220);
  }

  // ---------------- page engine (Dark Reader dynamic engine, MIT) ----------------
  DarkReader.setFetchMethod(async (url) => {
    const r = await send({type: 'fetch', url, as: 'bytes'});
    if (!r || !r.ok) throw new Error('Nadir fetch failed ' + url);
    const bin = atob(r.b64 || ''); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Response(u, {status: 200, headers: {'content-type': r.type || ''}});
  });
  let adoptedBefore = null;
  globalThis.__nadirMV3Proxy = true; // the engine's CSSOM proxy runs in the page world (registered by the background worker)
  function engineOn() {
    if (drOn) { DarkReader.refresh(THEME); return; }
    adoptedBefore = new Set(document.adoptedStyleSheets || []);
    DarkReader.enable(THEME);
    drOn = true;
  }
  function engineOff() { if (drOn) { DarkReader.disable(); drOn = false; } }
  const isEngineSheet = (sh) => { const n = sh.ownerNode; return !!(n && n.classList && n.classList.contains('darkreader') && !n.classList.contains('darkreader--sync')); };
  // run fn against the page's own (light) styles: engine sheets are disabled for one synchronous task, no paint in between
  function withLightStyles(fn) {
    if (!drOn) return fn();
    const els = [...document.querySelectorAll('style.darkreader')].filter((e) => e.sheet);
    const adopted = document.adoptedStyleSheets || [];
    const engineAdopted = adoptedBefore ? adopted.filter((s) => !adoptedBefore.has(s)) : [];
    els.forEach((e) => { e.sheet.disabled = true; });
    if (engineAdopted.length) document.adoptedStyleSheets = adopted.filter((s) => adoptedBefore.has(s));
    try { return fn(); } finally {
      els.forEach((e) => { if (e.sheet) e.sheet.disabled = false; });
      if (engineAdopted.length) document.adoptedStyleSheets = [...document.adoptedStyleSheets, ...engineAdopted];
    }
  }

  // ---------------- images ----------------
  let imgStyle = null, imgObserver = null;
  function applyImages() {
    if (!imgStyle) {
      imgStyle = document.createElement('style');
      imgStyle.className = 'nadir-images stylus'; // 'stylus' makes the engine leave these rules alone (it would darken the plate)
      imgStyle.textContent = Object.entries(NadirImageCSS).filter(([k]) => k !== 'dim' || settings.dimImages)
        .map(([k, v]) => `img[data-nadir-t="${k}"],svg[data-nadir-t="${k}"],image[data-nadir-t="${k}"]{${v}}`).join('\n');
      (document.head || document.documentElement).appendChild(imgStyle);
    }
    const run = () => {
      for (const img of document.images) {
        const src = img.currentSrc || img.src;
        let t = treat[img.currentSrc] || treat[img.src];
        if (t && t.startsWith('adapt')) { // 'adapt:<fallback>': try adapting the logo, else the fallback treatment
          const fallback = t.split(':')[1] || 'keep';
          const a = adapted.get(src);
          if (a && a.id && !cspBlocksData) {
            if (img.getAttribute('data-nadir-a') !== a.id) img.setAttribute('data-nadir-a', a.id);
            t = 'keep';
          } else {
            if (!a) adaptOne(src).then(() => run());
            if (img.hasAttribute('data-nadir-a')) img.removeAttribute('data-nadir-a');
            // pending: as it is (the curtain covers the first paint); blocked by CSP: a white-backed logo is inverted
            t = cspBlocksData && a && a.id ? (fallback === 'keep' ? 'invert' : fallback) : (a === 'plain' || a === 'fail' ? fallback : 'keep');
          }
        } else if (img.hasAttribute('data-nadir-a')) img.removeAttribute('data-nadir-a');
        if (t === undefined && drOn && src && /^(https?|data):/.test(src)) queueLate(img, src);
        if (t === 'remove') t = 'keep';
        if (t === 'photo') t = settings.dimImages && img.width * img.height >= 40000 ? 'dim' : 'keep'; // the user's own comfort setting
        if (t && t !== 'keep') { if (img.getAttribute('data-nadir-t') !== t) img.setAttribute('data-nadir-t', t); }
        else if (img.hasAttribute('data-nadir-t')) img.removeAttribute('data-nadir-t');
      }
      if (Object.keys(svgTreat).length) {
        for (const svg of document.querySelectorAll('svg')) {
          const sig = svgSig(svg);
          let t = sig && svgTreat[sig];
          if (t && t !== 'keep' && !spriteNeedsTreat(svg, sig)) t = null;
          if (t && t !== 'keep') { if (svg.getAttribute('data-nadir-t') !== t) svg.setAttribute('data-nadir-t', t); }
          else if (svg.hasAttribute('data-nadir-t')) svg.removeAttribute('data-nadir-t');
        }
      }
    };
    run();
    if (!imgObserver) {
      document.addEventListener('load', (e) => { if (e.target && e.target.tagName === 'IMG' && !treat[e.target.currentSrc || e.target.src]) applyImages(); }, true);
      let pending = false;
      imgObserver = new MutationObserver(() => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; run(); scheduleIcons(1500); }); } });
      imgObserver.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset']});
    }
  }
  // ---------------- the element head ----------------
  // Every image-like element (an <img>, a CSS background, one icon of a sprite sheet, a ::before/::after icon) is
  // measured and the model's element head decides how it is shown: keep, invert (hue-preserving), adapt (dark ink
  // turns light, brand colours stay, a white box goes) or remove (a light texture behind content). Decisions are keyed
  // by image URL (+ sprite crop) and remembered per site. The one fixed rule: anything the head itself recognises as a
  // photo or a person keeps its colours.
  let ctxVec = null, saveTimer = 0;
  const darkLab = (surf) => {
    const c = map && map.lookup('bg', surf[0], surf[1], surf[2], 1);
    const m = c && (/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c) || /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c));
    const rgb = m ? (m[0][0] === '#' ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [+m[1], +m[2], +m[3]]) : surf;
    return __nadirOklab(rgb);
  };
  const REMOVE_MIN = 0.7;
  function decide(r, kind) {
    if (!r) return 'keep';
    if ((r.role === 'photo' || r.role === 'avatar') && r.rp >= 0.5) return r.role === 'photo' ? 'photo' : 'keep'; // 'photo' = keep (dimmable on request)
    const p = r.probs || [1, 0, 0, 0];
    let t = r.t;
    // a surface that is light in the original and stays light in the dark design: the element is shown as designed.
    // Flipped (its dark ink made light) or removed, it would vanish against that surface
    if (t !== 'keep' && r.ulL >= 0.75 && r.udL >= 0.75) return 'keep';
    // only CSS backgrounds can go, and only when the head is sure: taking an image away is the costly mistake. On
    // held-out sites, removing at >= 70% confidence (else the best other option) cut wrong removals by 57%
    if (t === 'remove' && (kind !== 'bg' || p[3] < REMOVE_MIN)) t = p[2] > Math.max(p[0], p[1]) ? 'adapt' : (p[1] > p[0] ? 'invert' : 'keep');
    if (t === 'adapt') return 'adapt:' + (p[1] > p[0] ? 'invert' : 'keep'); // the fallback when there is nothing to adapt
    return t;
  }
  const cropKey = (src, crop) => src + (crop ? '#nadir-crop=' + crop.join(',') : '');
  const strip = (rec) => { const o = Object.assign({}, rec); delete o.dims; delete o.key; return o; };
  async function classifyRecords(recs) {
    if (!recs.length || !ctxVec || !map) return recs.map(() => null);
    const res = await send({type: 'imgstats', budget: 6000, dims: recs[0].dims, images: recs.map(strip)});
    const items = [], idx = [];
    recs.forEach((rec, i) => {
      const r = Array.isArray(res) ? res[i] : null;
      if (!r || !r.thumb || !r.f) return;
      items.push({f: r.f, thumb: r.thumb, ul: rec.under, ud: darkLab(rec.surf)});
      idx.push(i);
    });
    const out = items.length ? await send({type: 'classify', items, ctx: ctxVec}) : null;
    const dec = recs.map(() => null);
    if (Array.isArray(out)) idx.forEach((i, k) => { dec[i] = out[k]; if (dec[i]) { dec[i].ulL = items[k].ul[0]; dec[i].udL = items[k].ud[0]; } });
    return dec;
  }
  // remembered per site, except per-session blob: URLs and long inline images (they are decided again when seen)
  const keepable = (k) => !k.startsWith('blob:') && k.length <= 600;
  function remember(found) {
    const keys = Object.keys(found).filter(keepable);
    if (!keys.length || !site || site.mode !== 'model') return;
    const tr = site.treat || (site.treat = {});
    for (const k of keys) tr[k] = found[k];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSite(site), 1500);
  }
  // late <img>s: loaded after the analysis, beyond its budget, or new on a revisit of a known site
  const lateAsked = new Set(), lateQueue = [];
  let lateTimer = 0;
  function queueLate(img, src) {
    if (lateAsked.has(src) || lateAsked.size >= 600 || !img.complete || !img.naturalWidth || img.width * img.height < 64) return;
    lateAsked.add(src);
    lateQueue.push([img, src]);
    if (!lateTimer) lateTimer = setTimeout(flushLate, 250);
  }
  // records of images met after the analysis are taken against the page's own (light) styles, like the analysis:
  // the head reads the light surface under each image, and the palette gives it the dark one
  async function flushLate() {
    const items = lateQueue.splice(0, 60);
    if (!items.length) { lateTimer = 0; return; }
    const batch = withLightStyles(() => items.map(([img, src]) => Object.assign(__nadirImageRecord(img, 'img', src), {key: src})));
    const dec = await classifyRecords(batch);
    const found = {};
    batch.forEach((rec, i) => { found[rec.key] = treat[rec.key] = decide(dec[i], 'img'); });
    applyImages();
    remember(found);
    lateTimer = lateQueue.length ? setTimeout(flushLate, 50) : 0;
  }
  // CSS backgrounds the engine meets that the head has not seen: find an element that shows it, measure, decide
  const bgPending = new Map(), bgQueue = [];
  let bgTimer = 0;
  // a sprite sheet's icons were decided one by one (cut out as shown); the engine rewrites the sheet's CSS rule, so
  // it takes their majority: a thumbnail of a whole 10000-px sheet says little about any one icon
  function bgDecision(src) {
    const votes = {};
    const pre = src + '#nadir-crop=';
    for (const k in treat) if (k.startsWith(pre)) votes[treat[k]] = (votes[treat[k]] || 0) + 1;
    let best, n = 0;
    for (const t in votes) if (votes[t] > n) { best = t; n = votes[t]; }
    return best !== undefined ? best : treat[src];
  }
  function classifyBg(src, d) {
    if (bgPending.has(src)) return bgPending.get(src);
    const pr = new Promise((resolve) => {
      bgQueue.push({d, src, resolve});
      if (!bgTimer) bgTimer = setTimeout(flushBg, 60);
    });
    bgPending.set(src, pr);
    return pr;
  }
  function bgRecord({d, src}) {
    let el = null;
    try { const sel = (d.selector || '').replace(/::?(before|after)/g, ''); el = sel ? document.querySelector(sel) : null; } catch (e) { el = null; }
    if (el) { const r = el.getBoundingClientRect(); return __nadirImageRecord(el, 'bg', src, __nadirBgCrop(getComputedStyle(el), r.width, r.height)); }
    return Object.assign(__nadirImageRecord(document.body || document.documentElement, 'bg', src), {w: d.width || 24, h: d.height || 24, areaSum: (d.width || 24) * (d.height || 24), x: 0, y: 0, vx: 0, vy: 0});
  }
  async function flushBg() {
    const batch = bgQueue.splice(0, 60);
    bgTimer = bgQueue.length ? setTimeout(flushBg, 60) : 0;
    if (!batch.length) return;
    withLightStyles(() => batch.forEach((b) => { b.rec = bgRecord(b); }));
    const dec = await Promise.race([classifyRecords(batch.map((b) => b.rec)), sleep(4000).then(() => batch.map(() => null))]);
    const found = {};
    batch.forEach((b, i) => { const t = dec[i] ? decide(dec[i], 'bg') : undefined; if (t) found[b.src] = treat[b.src] = t; b.resolve(t); });
    remember(found);
  }
  // what the engine should do with a background image
  // (null = no decision: the engine's own handling; 'keep' = shown exactly as it is)
  async function bgValue(t, src) {
    if (!t) return null;
    if (t === 'keep' || t === 'photo') return 'keep';
    if (t === 'remove') return 'none';
    if (t === 'invert') return 'invert';
    if (t.startsWith('adapt')) {
      if (!adapted.has(src)) await adaptOne(src);
      const a = adapted.get(src);
      if (a && a.url && !cspBlocksData) return {url: a.url};
      return t.split(':')[1] === 'invert' ? 'invert' : 'keep';
    }
    return null;
  }

  // logos and flat graphics on their own white rectangle: the image itself is adapted (white -> transparent, dark
  // ink -> light, brand colours keep their hue) and shown through CSS `content`, so the page's DOM is never touched
  const adapted = new Map(); // src -> {id} | 'pending' | 'fail' | 'plain'
  let adaptStyle = null, adaptN = 0, cspBlocksData = false;
  document.addEventListener('securitypolicyviolation', (e) => {
    if (/^data/.test(e.blockedURI || '') && /img-src|default-src/.test(e.violatedDirective || '') && adaptStyle && !cspBlocksData) {
      cspBlocksData = true; // this site forbids data: images: fall back to a hue-preserving inversion
      if (imgObserver) applyImages();
    }
  });
  async function adaptOne(src) {
    adapted.set(src, 'pending');
    try {
      const r = await send({type: 'fetch', url: src, as: 'b64'});
      if (!r || !r.ok || !r.b64) { adapted.set(src, 'fail'); return; }
      const bin = atob(r.b64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const url = await NadirAdaptImage(new Blob([u8], {type: (r.type || '').split(';')[0]}));
      if (!url) { adapted.set(src, 'plain'); return; } // no uniform white background after all: leave it as it is
      const id = String(++adaptN);
      if (!adaptStyle) {
        adaptStyle = document.createElement('style');
        adaptStyle.className = 'nadir-adapt stylus';
        (document.head || document.documentElement).appendChild(adaptStyle);
      }
      adaptStyle.appendChild(document.createTextNode(`img[data-nadir-a="${id}"]{content:url("${url}") !important}\n`));
      adapted.set(src, {id, url});
    } catch (e) { adapted.set(src, 'fail'); }
  }

  // inline SVGs that pull their artwork from an external sprite cannot be recoloured by CSS; they get a whole-image treatment
  function svgSig(svg) {
    const uses = [...svg.querySelectorAll('use')].map((u) => u.getAttribute('href') || u.getAttribute('xlink:href') || '').filter((h) => h && !h.startsWith('#'));
    if (!uses.length) return null;
    const r = svg.getBoundingClientRect();
    return uses.join('|') + '@' + Math.round(r.width) + 'x' + Math.round(r.height);
  }
  // ...unless the sprite's shapes paint with currentColor or inherit their fill: then the engine already recolours them
  // like text, and a whole-image treatment on top would flip them back. Each sprite is read once: 'fixed' (its own
  // colours), 'color' (currentColor) or 'inherit' (no paint of its own).
  const spriteModes = new Map(); // absolute href -> mode | 'pending'
  const FIXED_PAINT = /^(?!none\b|currentcolor\b|inherit\b|transparent\b|context-|url\()./i;
  function spriteMode(href) {
    let abs;
    try { abs = new URL(href, location.href).href; } catch (e) { return 'fixed'; }
    const m = spriteModes.get(abs);
    if (m) return m;
    spriteModes.set(abs, 'pending');
    const [url, id] = abs.split('#');
    send({type: 'fetch', url, as: 'text'}).then((r) => {
      let mode = 'fixed';
      try {
        const doc = r && r.ok && r.text ? new DOMParser().parseFromString(r.text, 'image/svg+xml') : null;
        const root = doc && (id ? doc.getElementById(id) : doc.documentElement);
        if (root) {
          const paints = [];
          for (const el of [root, ...root.querySelectorAll('*')]) {
            for (const p of ['fill', 'stroke']) {
              const v = el.getAttribute(p), s = el.style && el.style.getPropertyValue(p);
              if (v) paints.push(v.trim());
              if (s) paints.push(s.trim());
            }
          }
          for (const st of doc.querySelectorAll('style')) for (const mm of st.textContent.matchAll(/(?:fill|stroke)\s*:\s*([^;}]+)/gi)) paints.push(mm[1].trim());
          mode = paints.some((v) => FIXED_PAINT.test(v)) ? 'fixed' : paints.some((v) => /^currentcolor/i.test(v)) ? 'color' : 'inherit';
        }
      } catch (e) { mode = 'fixed'; }
      spriteModes.set(abs, mode);
      applyImages();
    });
    return 'pending';
  }
  function spriteNeedsTreat(svg, sig) {
    const modes = sig.split('@')[0].split('|').map(spriteMode);
    if (modes.includes('fixed')) return true;
    if (modes.includes('pending')) return false; // decided when the sprite has been read
    const cs = getComputedStyle(svg);
    const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(modes.includes('color') ? cs.color : cs.fill);
    // the page's styles already made it light: nothing to do; still dark on the dark page: the decided treatment
    return !m || __nadirOklab([+m[1], +m[2], +m[3]])[0] < 0.5;
  }

  // ---------------- applying a learned mapping ----------------
  function applyMapping(entry) {
    map = new NadirMap(entry.tokens, entry.colors, {keep: new Set(entry.keep || [])});
    window.__nadirColorHook = (role, r, g, b, a) => map.lookup(role, r, g, b, a);
    window.__nadirFillSide = (r, g, b, a) => map.fillSide(r, g, b, a);
    treat = entry.treat || {}; svgTreat = entry.svg || {}; ctxVec = entry.ctx || null;
    window.__nadirBgImageHook = (src, d) => {
      const t = bgDecision(src);
      if (t !== undefined) return bgValue(t, src);
      if (!ctxVec) return null; // a mapping from before the element head: leave unknown backgrounds alone
      return classifyBg(src, d).then((t2) => bgValue(t2, src));
    };
    engineOn();
    applyImages();
    scheduleIcons(400);
  }

  // ---------------- CSS icons ----------------
  // Icons drawn by CSS instead of <img>: (1) a mask shape painted with a background colour: that colour is ink,
  // so it gets the text mapping, not the surface one; (2) an image inserted with `content: url(...)` in ::before /
  // ::after: measured like any image, and dark ink on transparency is inverted.
  let iconStyle = null, iconTimer = 0, iconRuns = 0, iconN = 0;
  const iconRules = new Map(); // key -> css rule text
  const contentStats = new Map(); // url -> treatment | 'pending'
  function scheduleIcons(ms) {
    if (iconTimer || iconRuns > 40 || !drOn || !map) return;
    iconTimer = setTimeout(() => { iconTimer = 0; iconRuns++; try { scanIcons(); } catch (e) {} }, ms);
  }
  const maskOf = (cs) => { const m = cs.maskImage || cs.webkitMaskImage || ''; return m && m !== 'none' && !/^linear-gradient/.test(m); };
  const urlOf = (c) => { const m = /^url\(\s*["']?([^"')]+)["']?\s*\)/.exec(c || ''); return m ? m[1] : null; };
  function markOf(el) { let k = el.getAttribute('data-nadir-icon'); if (!k) { k = String(++iconN); el.setAttribute('data-nadir-icon', k); } return k; }
  const sel = (k, ps) => `[data-nadir-icon="${k}"][data-nadir-icon="${k}"][data-nadir-icon="${k}"]${ps || ''}`;
  function scanIcons() {
    const masks = [], contents = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i];
      if (el.hasAttribute('data-nadir-icon')) continue;
      // icon-sized: the element itself, or a sprite sheet clipped by an icon-sized parent
      let r = el.getBoundingClientRect(), crop = null, host = null;
      if ((r.width > 72 || r.height > 72) && el.parentElement) {
        const pr = el.parentElement.getBoundingClientRect();
        if (pr.width <= 72 && pr.height <= 72 && pr.width >= 4 && pr.height >= 4 && getComputedStyle(el.parentElement).overflow !== 'visible') {
          crop = [Math.round(pr.x - r.x), Math.round(pr.y - r.y), Math.round(pr.width), Math.round(pr.height), 0, 0];
          r = pr; host = el.parentElement.childElementCount === 1 ? el.parentElement : null;
        }
      }
      if (r.width > 400 || r.height > 160 || (r.width < 4 && r.height < 4 && el.childElementCount === 0 && !el.firstChild)) continue;
      const cs = getComputedStyle(el);
      if (maskOf(cs)) masks.push([el, '']); // a mask can be a whole wordmark, not just an icon
      if (r.width > 72 || r.height > 72) continue;
      for (const ps of ['::before', '::after']) {
        const p = getComputedStyle(el, ps);
        if (p.content === 'none' || p.content === 'normal') continue;
        if (maskOf(p)) masks.push([el, ps]);
        const u = urlOf(p.content);
        if (u) { const src = new URL(u, location.href).href; contents.push([el, ps, cropKey(src, crop), host, src, crop, r]); }
      }
    }
    if (masks.length) {
      // the original (light-design) ink colour of each mask icon, read once with the engine's sheets off
      const orig = withLightStyles(() => masks.map(([el, ps]) => getComputedStyle(el, ps || null).backgroundColor));
      masks.forEach(([el, ps], i) => {
        const c = /rgba?\(([^)]+)\)/.exec(orig[i]);
        if (!c) return;
        const [r, g, b, a = 1] = c[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        if (!(a > 0.05)) return;
        const out = map.lookup('text', r, g, b, a);
        if (!out) return;
        const k = markOf(el);
        iconRules.set(k + ps, `${sel(k, ps)}{background-color:${out} !important}`);
      });
    }
    const need = [];
    for (const c of contents) {
      const [el, , key, , src, crop, box] = c;
      markOf(el);
      if (treat[key] === undefined && !contentStats.has(key)) { contentStats.set(key, 'pending'); need.push(c); }
      contentRule(c);
    }
    if (need.length) {
      const recs = withLightStyles(() => need.slice(0, 80).map(([el, , , , src, crop, box]) => __nadirImageRecord(el, 'pseudo', src, crop, box)));
      measureContent(recs, contents);
    }
    writeIconRules();
  }
  async function measureContent(recs, contents) {
    const dec = await classifyRecords(recs);
    const found = {};
    recs.forEach((rec, i) => {
      const key = cropKey(rec.src, rec.cropPx);
      const t = decide(dec[i], 'pseudo');
      contentStats.set(key, t); found[key] = t;
    });
    remember(found);
    contents.forEach(contentRule);
    writeIconRules();
  }
  // a treated content icon: the filter goes on the pseudo-element, or for a sprite sheet on its icon-sized clipping
  // box (Chrome does not paint filters on some huge sprite layers, e.g. Google Docs' toolbar). Adapting a sprite
  // cut-out is not possible in CSS: dark-ink icons get the hue-preserving inversion instead.
  function contentRule([el, ps, key, host]) {
    let t = treat[key] !== undefined ? treat[key] : contentStats.get(key);
    if (t && t.startsWith('adapt')) t = 'invert';
    if (!t || t === 'pending' || t === 'keep' || !NadirImageCSS[t]) return;
    if (host) { const k = markOf(host); iconRules.set(k, `${sel(k, '')}{${NadirImageCSS[t]}}`); }
    else { const k = el.getAttribute('data-nadir-icon'); iconRules.set(k + ps, `${sel(k, ps)}{${NadirImageCSS[t]}}`); }
  }
  function writeIconRules() {
    if (!iconRules.size) return;
    if (!iconStyle) {
      iconStyle = document.createElement('style');
      iconStyle.className = 'nadir-icons stylus'; // the engine leaves 'stylus' sheets alone
      (document.head || document.documentElement).appendChild(iconStyle);
    }
    iconStyle.textContent = [...iconRules.values()].join('\n');
  }

  // ---------------- site's own dark theme ----------------
  const DARK_Q = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, LIGHT_Q = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi;
  const flipMedia = (t) => t.replace(DARK_Q, '(min-width: 0px)').replace(LIGHT_Q, '(max-width: -1px)');
  const native = {
    on: false, undo: [], observer: null,
    flipRules(rules) {
      for (const rule of rules) {
        if (rule.media && rule.media.mediaText && /prefers-color-scheme/i.test(rule.media.mediaText)) {
          const old = rule.media.mediaText;
          try { rule.media.mediaText = flipMedia(old); this.undo.push(() => { try { rule.media.mediaText = old; } catch (e) {} }); } catch (e) {}
        }
        if (rule.cssRules) this.flipRules(rule.cssRules);
      }
    },
    async processSheetOwner(node) {
      if (node.__nadirNative) return;
      node.__nadirNative = true;
      const m = node.getAttribute && node.getAttribute('media');
      if (m && /prefers-color-scheme/i.test(m)) { node.setAttribute('media', flipMedia(m)); this.undo.push(() => node.setAttribute('media', m)); }
      const sh = node.sheet;
      if (!sh) return;
      let rules = null;
      try { rules = sh.cssRules; } catch (e) { rules = null; }
      if (rules) { this.flipRules(rules); return; }
      // cross-origin stylesheet: fetch its text, flip the queries, put the copy in its place
      if (node.tagName === 'LINK' && node.href) {
        const r = await send({type: 'fetch', url: node.href, as: 'text'});
        if (!r || !r.ok || !/prefers-color-scheme/i.test(r.text || '')) return;
        const base = node.href;
        const css = flipMedia(r.text).replace(/url\(\s*(['"]?)(?!data:|https?:|\/\/|#)([^'")]+)\1\s*\)/g, (_, q, u) => { try { return `url("${new URL(u, base).href}")`; } catch (e) { return _; } });
        const st = document.createElement('style');
        st.className = 'nadir-native'; st.textContent = css;
        node.after(st);
        const oldMedia = node.getAttribute('media');
        node.setAttribute('media', 'not all');
        this.undo.push(() => { st.remove(); if (oldMedia === null) node.removeAttribute('media'); else node.setAttribute('media', oldMedia); });
      }
    },
    apply() {
      if (this.on) return;
      this.on = true;
      document.documentElement.setAttribute('data-nadir-mm', 'on');
      const scan = () => {
        for (const n of document.querySelectorAll('link[rel~="stylesheet"], style')) if (!n.classList.contains('darkreader') && !n.classList.contains('nadir-native')) this.processSheetOwner(n);
        for (const s of document.querySelectorAll('picture source[media]')) {
          const m = s.getAttribute('media');
          if (/prefers-color-scheme/i.test(m) && !s.__nadirNative) { s.__nadirNative = true; s.setAttribute('media', flipMedia(m)); this.undo.push(() => s.setAttribute('media', m)); }
        }
        for (const sh of document.adoptedStyleSheets || []) { try { this.flipRules(sh.cssRules); } catch (e) {} }
      };
      scan();
      const cs = getComputedStyle(document.documentElement).colorScheme || '';
      const meta = document.querySelector('meta[name="color-scheme"]');
      if (/dark/.test(cs) || (meta && /dark/.test(meta.content))) {
        const old = document.documentElement.style.getPropertyValue('color-scheme');
        document.documentElement.style.setProperty('color-scheme', 'dark', 'important');
        this.undo.push(() => document.documentElement.style.setProperty('color-scheme', old));
      }
      this.observer = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType === 1 && (n.tagName === 'LINK' || n.tagName === 'STYLE')) {
            if (n.tagName === 'LINK' && !n.sheet) n.addEventListener('load', () => this.processSheetOwner(n), {once: true});
            else this.processSheetOwner(n);
          }
        }
      });
      this.observer.observe(document.documentElement, {subtree: true, childList: true});
    },
    revert() {
      if (!this.on) return;
      this.on = false;
      if (this.observer) this.observer.disconnect();
      for (const u of this.undo.reverse()) u();
      this.undo = [];
      for (const n of document.querySelectorAll('link,style')) delete n.__nadirNative;
    },
  };
  const toggle = {
    undo: [],
    apply(sel) {
      const m = sel.match(/^(html|body|:root)?(.*)$/);
      const rest = m[2];
      const targets = [document.documentElement, document.body].filter(Boolean);
      const cm = rest.match(/^\.([\w-]+)$/);
      const am = rest.match(/^\[([\w-]+)(?:[~|^*$]?=\s*["']?([\w-]+)["']?)?\s*(?:i\s*)?\]$/);
      if (cm) { for (const t of targets) if (!t.classList.contains(cm[1])) { t.classList.add(cm[1]); this.undo.push(() => t.classList.remove(cm[1])); } return true; }
      if (am) { for (const t of targets) { const old = t.getAttribute(am[1]); t.setAttribute(am[1], am[2] || 'dark'); this.undo.push(() => old === null ? t.removeAttribute(am[1]) : t.setAttribute(am[1], old)); } return true; }
      return false;
    },
    revert() { for (const u of this.undo.reverse()) u(); this.undo = []; },
  };

  // ---------------- analysis ----------------
  // __nadirExtract walks the DOM synchronously before its first await, so the engine is paused only for that walk
  function extractNow(extra) {
    let pr;
    withLightStyles(() => {
      pr = __nadirExtract({describe: false, thumbs: false, markSvg: true, maxImages: 120, srcMax: 4e6, sheetFilter: (sh) => !isEngineSheet(sh), extraSheets: extra || []});
    });
    return pr;
  }
  async function crossOriginSheets() {
    const out = [];
    const jobs = [];
    for (const sh of document.styleSheets) {
      if (isEngineSheet(sh)) continue;
      try { void sh.cssRules; continue; } catch (e) {}
      if (!sh.href) continue;
      jobs.push(send({type: 'fetch', url: sh.href, as: 'text'}).then((r) => {
        if (!r || !r.ok) return;
        try { const s = new CSSStyleSheet(); s.replaceSync(r.text.replace(/@import[^;]+;/g, '')); out.push(s); } catch (e) {}
      }));
    }
    await Promise.race([Promise.all(jobs), sleep(700)]);
    return out;
  }
  async function stylesReady(maxMs) {
    if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, {once: true}));
    const deadline = performance.now() + maxMs;
    while (performance.now() < deadline) {
      const pending = [...document.querySelectorAll('link[rel~="stylesheet"]')].some((l) => !l.sheet && !l.disabled && (!l.media || l.media === 'all' || matchMedia(l.media).matches));
      if (!pending) break;
      await sleep(50);
    }
    await frames(2);
  }

  async function imageStats(page) {
    if (!page.images.length) return;
    // the screenshot must show the light page: never while the engine is active (revisits reuse cached SVG decisions)
    const wantShot = isTop && !drOn && page.images.some((im) => im.kind === 'svg' && im.useExt && im.vy >= 0 && im.vy + im.h <= innerHeight);
    let restore = null;
    if (wantShot && curtain) { curtain.style.transition = 'none'; curtain.style.opacity = '0'; await frames(2); restore = () => { if (curtain) { curtain.style.opacity = '1'; curtain.style.transition = ''; } }; }
    const pr = send({type: 'imgstats', images: page.images, wantShot, dims: {vw: page.vw, vh: page.vh, docH: page.docH}, dpr: devicePixelRatio});
    if (restore) { setTimeout(restore, 40); }
    const res = await pr;
    if (res && Array.isArray(res)) res.forEach((r, i) => Object.assign(page.images[i], r));
  }

  async function runModel(page, merge) {
    await imageStats(page);
    mark('imgstats');
    const slim = {vw: page.vw, vh: page.vh, docH: page.docH, darkness: page.darkness, canvasDark: page.canvasDark, stats: page.stats,
      tokens: page.tokens, rel: page.rel, images: page.images.map((im) => ({f: im.f, thumb: im.thumb, underTok: im.underTok, w: im.w, h: im.h, kind: im.kind, src: im.src}))};
    const res = await send({type: 'infer', page: slim});
    if (!res || res.error) throw new Error('inference failed: ' + (res && res.error));
    const entry = {mode: 'model', v: MODEL_VERSION, t: Date.now(), tokens: page.tokens.slice(0, 256).map((t) => ({role: t.role, rgba: t.rgba})),
      colors: res.colors, keep: res.keep, treat: {}, svg: {}, ctx: res.ctx, ms: res.ms, elemMs: res.elemMs};
    // the element head's decision for every measured image; the rest is measured and decided when the page shows it
    page.images.forEach((im, j) => {
      const r = res.elements && res.elements[j];
      if (!r) return;
      const t = decide(r, im.kind);
      if (im.kind === 'svg') {
        if (im.useExt) { const el = document.querySelector(`[data-nadir-svg="${im.src}"]`); const sig = el && svgSig(el); if (sig) entry.svg[sig] = t.startsWith('adapt') ? 'invert' : t; }
        return;
      }
      entry.treat[cropKey(im.src, im.cropPx)] = t;
    });
    if (merge && site && site.mode === 'model') {
      // keep what earlier pages of this site taught us; this page's own answers win
      const seen = new Set(entry.tokens.map((t) => t.role + ':' + t.rgba.join(',')));
      const keepIdx = new Set(site.keep || []);
      site.tokens.forEach((t, i) => {
        if (entry.tokens.length >= 700) return;
        const k = t.role + ':' + t.rgba.join(',');
        if (seen.has(k)) return;
        if (keepIdx.has(i)) entry.keep.push(entry.tokens.length);
        entry.tokens.push(t); entry.colors.push(site.colors[i]);
      });
      entry.treat = Object.assign({}, site.treat, entry.treat);
      entry.svg = Object.assign({}, site.svg, entry.svg);
    }
    return entry;
  }

  function coverage(page, entry) {
    const known = new Set(entry.tokens.map((t) => t.role + ':' + t.rgba.join(',')));
    let tot = 0, hit = 0;
    for (const t of page.tokens) {
      const w = Math.exp(t.f[10] * 10) + 20 * t.f[19];
      tot += w; if (known.has(t.role + ':' + t.rgba.join(','))) hit += w;
    }
    return tot ? hit / tot : 1;
  }

  async function saveSite(entry) {
    site = entry;
    if (!isTop) return;
    // per-session blob: URLs and long inline images are used on this page but not stored
    const stored = entry.treat ? Object.assign({}, entry, {treat: Object.fromEntries(Object.entries(entry.treat).filter(([k]) => keepable(k)))}) : entry;
    await chrome.storage.local.set({[SITE_KEY]: stored});
  }
  function report(mode, extra) {
    if (isTop) send({type: 'status', status: Object.assign({mode, host: HOST, ms: Math.round(performance.now() - t0), timing}, extra || {})});
  }

  async function fresh(force) {
    await stylesReady(1200);
    mark('styles');
    const extra = await crossOriginSheets();
    mark('xsheets');
    let page = await extractNow(extra);
    mark('extract');
    if (DARK_THRESHOLD(page.darkness)) { await saveSite({mode: 'dark', t: Date.now()}); hideCurtain(); return report('dark'); }
    const sc = page.scheme;
    const forceModel = settings.forceModel.includes(HOST);
    let touched = false;
    if (!forceModel && (sc.darkMediaColorDecls >= 6 || sc.darkLinks > 0 || (sc.metaColorScheme && /dark/.test(sc.metaColorScheme)))) {
      touched = true;
      native.apply();
      await sleep(350); await frames(2);
      const p2 = await extractNow();
      if (DARK_THRESHOLD(p2.darkness)) { await saveSite({mode: 'native', t: Date.now()}); hideCurtain(); return report('native'); }
      native.revert();
      await frames(1);
    }
    if (!forceModel) {
      for (const [sel, n] of (sc.darkSelectors || []).slice(0, 3)) {
        if (n < 8 || !toggle.apply(sel)) continue;
        touched = true;
        await sleep(350); await frames(2);
        const p3 = await extractNow();
        if (DARK_THRESHOLD(p3.darkness)) { await saveSite({mode: 'class', sel, t: Date.now()}); hideCurtain(); return report('native', {sel}); }
        toggle.revert();
        await frames(1);
      }
    }
    if (touched) { page = await extractNow(extra); mark('extract2'); }
    const entry = await runModel(page, false);
    mark('model');
    applyMapping(entry);
    await frames(2);
    mark('applied');
    hideCurtain();
    await saveSite(entry);
    report('model', {infer: entry.ms, tokens: entry.tokens.length});
  }

  async function revisitModel() {
    applyMapping(site);   // instant: no flash on known sites
    hideCurtain();
    await stylesReady(2500);
    await sleep(300);
    const extra = await crossOriginSheets();
    const page = await extractNow(extra);
    const cov = coverage(page, site);
    if (cov < 0.92 || site.v !== MODEL_VERSION) {
      const entry = await runModel(page, site.v === MODEL_VERSION);
      applyMapping(entry);
      await saveSite(entry);
      return report('model', {infer: entry.ms, coverage: +cov.toFixed(2), tokens: entry.tokens.length});
    }
    report('model', {cached: true, coverage: +cov.toFixed(2)});
  }

  async function main() {
    if (isTop) showCurtain();
    const st = await chrome.storage.local.get(['settings', SITE_KEY]);
    settings = Object.assign({enabled: true, disabledHosts: [], forceModel: [], curtain: true, dimImages: false, iframes: true}, st.settings || {});
    site = st[SITE_KEY] || null;
    if (!settings.enabled || settings.disabledHosts.includes(HOST) || (!isTop && !settings.iframes)) {
      if (document.documentElement) document.documentElement.setAttribute('data-nadir-mm', 'off');
      hideCurtain(); return report('off');
    }
    if (!isTop) {
      // small frames (buttons, trackers) are not worth a model run
      await stylesReady(1500);
      if (innerWidth * innerHeight < 300 * 150) return;
      site = null; // frames are analysed fresh; their host cache belongs to their own top-level visits
    }
    if (site && site.mode !== 'model' && site.mode !== 'dark' && settings.forceModel.includes(HOST)) site = null;
    try {
      if (site && site.mode === 'model') return await revisitModel();
      if (site && site.mode === 'native') {
        native.apply(); hideCurtain();
        await stylesReady(2500); await sleep(400);
        const p = await extractNow();
        if (!DARK_THRESHOLD(p.darkness)) { native.revert(); site = null; return await fresh(); }
        return report('native');
      }
      if (site && site.mode === 'class') {
        if (document.documentElement) toggle.apply(site.sel);
        if (!document.body) await new Promise((r) => document.addEventListener('DOMContentLoaded', r, {once: true}));
        toggle.revert(); toggle.apply(site.sel); hideCurtain();
        await stylesReady(2500); await sleep(300);
        const p = await extractNow();
        if (!DARK_THRESHOLD(p.darkness)) { toggle.revert(); site = null; return await fresh(); }
        return report('native', {sel: site.sel});
      }
      if (site && site.mode === 'dark') {
        hideCurtain();
        await stylesReady(2500);
        const p = await extractNow();
        if (DARK_THRESHOLD(p.darkness)) return report('dark');
        site = null;
      }
      if (!settings.curtain) hideCurtain();
      await fresh();
    } catch (e) {
      hideCurtain();
      report('error', {error: String(e && e.message || e).slice(0, 200)});
    }
  }

  // popup -> page commands
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'nadir:reanalyze' && isTop) {
      engineOff(); native.revert(); toggle.revert();
      chrome.storage.local.remove(SITE_KEY).then(() => location.reload());
      reply(true);
    }
    return false;
  });

  main();
})();
