'use strict';
const $ = (id) => document.getElementById(id);
const DEFAULTS = {enabled: true, disabledHosts: [], forceModel: [], curtain: true, dimImages: false, iframes: true};
const LABEL = {
  model: ['Nadir AI dark theme', 'Designed on this device by the Nadir model'],
  native: ["Using the site's own dark theme", 'Nadir switched it on for you'],
  dark: ['Already dark', 'Nadir leaves this site as it is'],
  off: ['Off for this site', ''],
  error: ['Something went wrong', ''],
  pending: ['Working…', ''],
};
(async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (e) {}
  $('host').textContent = host || 'This page';
  const {settings: s0} = await chrome.storage.local.get('settings');
  const s = Object.assign({}, DEFAULTS, s0 || {});
  const st = (await chrome.storage.session.get('tab:' + tab.id))['tab:' + tab.id];
  const lab = LABEL[st && st.mode] || (/^https?:/.test(tab.url || '') ? LABEL.pending : ['Not available here', 'Browser pages cannot be changed']);
  $('st').textContent = lab[0];
  let sub = lab[1];
  if (st && st.mode === 'model') sub += st.cached ? ' · from cache' : (st.infer != null ? ` · ${st.infer} ms` : '');
  if (st && st.error) sub = st.error;
  $('sub').textContent = sub;
  $('site').checked = s.enabled && !s.disabledHosts.includes(host);
  $('force').checked = s.forceModel.includes(host);
  $('dim').checked = s.dimImages;
  $('curtain').checked = s.curtain;
  $('all').checked = s.enabled;
  const save = async (mut, reload) => {
    mut(s);
    await chrome.storage.local.set({settings: s});
    if (reload && tab.id) chrome.tabs.reload(tab.id);
  };
  const setHost = (list, on) => { const i = list.indexOf(host); if (on && i < 0) list.push(host); if (!on && i >= 0) list.splice(i, 1); };
  $('site').onchange = () => save((x) => setHost(x.disabledHosts, !$('site').checked), true);
  $('force').onchange = async () => { await chrome.storage.local.remove('site:' + host); save((x) => setHost(x.forceModel, $('force').checked), true); };
  $('dim').onchange = () => save((x) => { x.dimImages = $('dim').checked; }, true);
  $('curtain').onchange = () => save((x) => { x.curtain = $('curtain').checked; }, false);
  $('all').onchange = () => save((x) => { x.enabled = $('all').checked; }, true);
  $('re').onclick = async () => { await chrome.storage.local.remove('site:' + host); chrome.tabs.reload(tab.id); window.close(); };
})();
