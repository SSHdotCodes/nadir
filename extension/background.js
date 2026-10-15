// Nadir background service worker: settings, per-site cache, network proxy for the page engine,
// screenshot capture for inline-SVG logos, and the offscreen document that runs the model.
'use strict';

const DEFAULTS = {enabled: true, disabledHosts: [], forceModel: [], curtain: true, dimImages: false, iframes: true};
const MAIN_WORLD_ID = 'nadir-main-world';

async function getSettings() {
  const {settings} = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULTS, settings || {});
}

// The matchMedia patch must run in the page's own world before its scripts, so it is registered
// dynamically and excludes the sites the user turned Nadir off for.
async function syncMainWorld() {
  const s = await getSettings();
  try { await chrome.scripting.unregisterContentScripts({ids: [MAIN_WORLD_ID]}); } catch (e) {}
  if (!s.enabled) return;
  const exclude = [];
  for (const h of s.disabledHosts) exclude.push(`*://${h}/*`);
  await chrome.scripting.registerContentScripts([{
    id: MAIN_WORLD_ID, js: ['lib/dr-proxy.js', 'mainworld.js'], matches: ['<all_urls>'], excludeMatches: exclude,
    runAt: 'document_start', allFrames: true, world: 'MAIN', persistAcrossSessions: true,
  }]);
}
chrome.runtime.onInstalled.addListener(syncMainWorld);

// An unpacked install picks up updated files on disk by itself: when the manifest on disk carries a new version,
// the extension reloads (checked at most once a minute, whenever a page talks to it).
let lastUpdateCheck = 0;
async function checkForUpdate() {
  if (Date.now() - lastUpdateCheck < 60 * 1000) return;
  lastUpdateCheck = Date.now();
  try {
    const m = await (await fetch(chrome.runtime.getURL('manifest.json'), {cache: 'no-store'})).json();
    if (m.version && m.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch (e) {}
}
chrome.runtime.onStartup.addListener(syncMainWorld);
chrome.storage.onChanged.addListener((ch) => { if (ch.settings) syncMainWorld(); });

// ---------- offscreen model runner ----------
let creating = null;
let lastUse = 0;
async function ensureOffscreen() {
  lastUse = Date.now();
  if (creating) return creating; // another tab is creating it right now
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['WORKERS', 'DOM_SCRAPING'],
      justification: 'Runs the on-device Nadir model and analyzes images for dark mode.'}).finally(() => { creating = null; });
  }
  await creating;
}
async function toOffscreen(msg) {
  for (let i = 0; ; i++) {
    await ensureOffscreen();
    try {
      return await chrome.runtime.sendMessage(Object.assign({target: 'offscreen'}, msg));
    } catch (e) {
      // the document exists but its scripts are still loading (several tabs asked at once on a fresh start)
      if (i >= 50 || !/Receiving end does not exist/i.test(String((e && e.message) || e))) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
// free the model's memory when idle
setInterval(async () => {
  if (Date.now() - lastUse > 10 * 60 * 1000 && await chrome.offscreen.hasDocument()) chrome.offscreen.closeDocument().catch(() => {});
}, 60 * 1000);

// ---------- network proxy (cross-origin CSS and images for the page engine) ----------
function b64(buf) {
  let s = '';
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
async function proxyFetch(url, as) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, {credentials: 'omit', signal: ac.signal, cache: 'force-cache'});
    const type = r.headers.get('content-type') || '';
    if (as === 'text') return {ok: r.ok, status: r.status, type, text: await r.text()};
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 12e6) return {ok: false, status: 413, type};
    return {ok: r.ok, status: r.status, type, b64: b64(buf)};
  } catch (e) {
    return {ok: false, status: 0, error: String(e)};
  } finally { clearTimeout(t); }
}

// Some sites serve their images and stylesheets only to their own pages (hotlink protection on the Referer). The
// extension's own fetch of something a page already loaded carries that page's origin as the Referer, as the page's
// request did. Session rules scoped to this extension's requests, never the page's.
const refRules = new Map(); // request host -> {id, origin}
let refNext = 1;
const refReady = chrome.declarativeNetRequest.getSessionRules()
  .then((rs) => rs.length && chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: rs.map((r) => r.id)})).catch(() => {});
async function refererFor(urls, pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch (e) { return; }
  if (!/^https?:/.test(origin)) return;
  await refReady;
  if (refRules.size > 2000) {
    const ids = [...refRules.values()].map((r) => r.id);
    refRules.clear();
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: ids}).catch(() => {});
  }
  const add = [], remove = [];
  for (const u of urls) {
    let host;
    try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) continue; host = x.hostname; } catch (e) { continue; }
    const cur = refRules.get(host);
    if (cur && cur.origin === origin) continue;
    const id = cur ? cur.id : refNext++;
    if (cur) remove.push(id);
    refRules.set(host, {id, origin});
    add.push({id, priority: 1, action: {type: 'modifyHeaders', requestHeaders: [{header: 'referer', operation: 'set', value: origin + '/'}]},
      condition: {requestDomains: [host], initiatorDomains: [chrome.runtime.id], tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ['xmlhttprequest', 'other']}});
  }
  if (add.length) await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: remove, addRules: add}).catch(() => {});
}
const pageOf = (sender) => sender.url || (sender.tab && sender.tab.url) || '';

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.target !== 'offscreen') checkForUpdate();
  if (msg.target === 'offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'fetch': await refererFor([msg.url], pageOf(sender)); return proxyFetch(msg.url, msg.as);
      case 'infer': return toOffscreen({type: 'infer', page: msg.page});
      case 'classify': return toOffscreen({type: 'classify', items: msg.items, ctx: msg.ctx});
      case 'imgstats': {
        await refererFor((msg.images || []).map((o) => o.src), pageOf(sender));
        let shot = null;
        if (msg.wantShot && sender.tab) {
          try { shot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {format: 'png'}); } catch (e) { shot = null; }
        }
        return toOffscreen({type: 'imgstats', images: msg.images, shot, dims: msg.dims, dpr: msg.dpr, budget: msg.budget});
      }
      case 'settings': return getSettings();
      case 'status': {
        // content script reports what it did, for the popup
        if (sender.tab && sender.frameId === 0) {
          await chrome.storage.session.set({['tab:' + sender.tab.id]: msg.status});
          setBadge(sender.tab.id, msg.status);
        }
        return true;
      }
      default: return null;
    }
  })().then(reply, (e) => reply({error: String(e)}));
  return true;
});

const BADGE = {model: ['AI', '#5b6cff'], native: ['ON', '#2f9e6a'], dark: ['', '#000'], off: ['OFF', '#666'], error: ['!', '#c33']};
function setBadge(tabId, status) {
  const b = BADGE[status && status.mode] || ['', '#000'];
  chrome.action.setBadgeText({tabId, text: b[0]}).catch(() => {});
  chrome.action.setBadgeBackgroundColor({tabId, color: b[1]}).catch(() => {});
}
chrome.tabs.onRemoved.addListener((id) => chrome.storage.session.remove('tab:' + id));
