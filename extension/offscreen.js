// Offscreen document: owns the ONNX Runtime session (one model instance shared by all tabs) and image analysis.
'use strict';
const MODEL_URL = chrome.runtime.getURL('model/nadir.onnx');
const ELEM_URL = chrome.runtime.getURL('model/nadir-elem.onnx');
const META_URL = chrome.runtime.getURL('model/nadir-meta.json');
let sessionP = null, elemP = null, metaP = null;
let stats = {runs: 0, ms: 0, elemRuns: 0, elemMs: 0, threads: 1, backend: 'wasm'};

function setup() {
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/ort/');
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) >> 1)) : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.simd = true;
  stats.threads = threads;
}
function session() {
  if (!sessionP) { setup(); sessionP = ort.InferenceSession.create(MODEL_URL, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'}); }
  return sessionP;
}
function elemSession() {
  if (!elemP) { session(); elemP = ort.InferenceSession.create(ELEM_URL, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'}); }
  return elemP;
}
function meta() {
  if (!metaP) metaP = fetch(META_URL).then((r) => r.json()).catch(() => ({temperature: 1}));
  return metaP;
}
const tensor = (data, dims) => new ort.Tensor(data instanceof BigInt64Array ? 'int64' : data instanceof Uint8Array ? 'bool' : 'float32', data, dims);

// the element head: how each image is shown (keep / invert / adapt / remove) and what it is
async function classify(items, ctx) {
  if (!items.length) return [];
  const [sess, m] = await Promise.all([elemSession(), meta()]);
  const out = [];
  for (let k = 0; k < items.length; k += 64) {
    const part = items.slice(k, k + 64);
    const built = NadirInfer.buildElemInputs(part, ctx);
    const feeds = {};
    for (const [name, [data, dims]] of Object.entries(built.feeds)) feeds[name] = tensor(data, dims);
    const t0 = performance.now();
    const r = await sess.run(feeds);
    stats.elemRuns++; stats.elemMs += performance.now() - t0;
    out.push(...NadirInfer.decodeElements(r.treat_logits.data, r.role_logits.data, part.length, m.temperature));
  }
  return out;
}

async function infer(page) {
  const sess = await session();
  const built = NadirInfer.buildInputs(page);
  const feeds = {};
  for (const [name, [data, dims]] of Object.entries(built.feeds)) feeds[name] = tensor(data, dims);
  const t0 = performance.now();
  const out = await sess.run(feeds);
  const ms = performance.now() - t0;
  stats.runs++; stats.ms += ms;
  const res = NadirInfer.decode(page, built, {lab: out.lab.data, alpha_logit: out.alpha_logit.data});
  res.ctx = Array.from(out.ctx.data, (v) => +v.toFixed(5));
  // every measured image of the page, not only the ones the palette model looked at
  const {items, idx} = NadirInfer.pageElementItems(page, {lab: out.lab.data});
  const t1 = performance.now();
  const dec = await classify(items, res.ctx);
  res.elements = {};
  // the lightness of the surface under each element before and as shown (after the design guards), for the runtime's rules
  idx.forEach((j, k) => { const d = dec[k]; if (d) { d.ulL = items[k].ul[0]; d.udL = res.Ls[items[k].u]; } res.elements[j] = d; });
  delete res.Ls;
  res.ms = Math.round(ms);
  res.elemMs = Math.round(performance.now() - t1);
  return res;
}

async function imgstats(images, shot, dims, dpr, budget) {
  // analysis is bounded: whatever is not done in time is sent without pixel stats (the model handles that)
  const work = __nadirImageStats(images, {shot, dpr: dpr || 1, bigThumbSize: 0, concurrency: 10});
  const res = await Promise.race([work, new Promise((r) => setTimeout(() => r(null), budget || 650))]) || images.map((o) => ({stats: o.stats || null, thumb: o.thumb || null}));
  images.forEach((o, i) => { Object.assign(o, res[i]); o.f = dims ? __nadirImageFeatures(o, dims.vw, dims.vh, dims.docH) : null; });
  return images.map(o => ({stats: o.stats, thumb: o.thumb, f: o.f}));
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== 'offscreen') return false;
  (async () => {
    if (msg.type === 'infer') return await infer(msg.page);
    if (msg.type === 'classify') return await classify(msg.items, msg.ctx);
    if (msg.type === 'imgstats') return await imgstats(msg.images, msg.shot, msg.dims, msg.dpr, msg.budget);
    if (msg.type === 'stats') return stats;
    return null;
  })().then(reply, (e) => reply({error: String(e && e.message || e)}));
  return true;
});
