// Runs in the page's own JavaScript world at document_start (registered by the background worker).
// Makes prefers-color-scheme queries answer "dark", so sites with a JS-driven dark theme switch it on.
(() => {
  if (window.__nadirMM) return;
  window.__nadirMM = true;
  const orig = window.matchMedia;
  if (typeof orig !== 'function') return;
  const DARK = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, LIGHT = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi;
  const off = () => document.documentElement && document.documentElement.getAttribute('data-nadir-mm') === 'off';
  window.matchMedia = function (q) {
    const real = orig.call(window, q);
    if (typeof q !== 'string' || !/prefers-color-scheme/i.test(q)) return real;
    const flipped = orig.call(window, q.replace(DARK, '(min-width: 0px)').replace(LIGHT, '(max-width: -1px)'));
    return new Proxy(real, {
      get(t, p) {
        if (p === 'matches') return off() ? t.matches : flipped.matches;
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  };
  try { Object.defineProperty(window.matchMedia, 'toString', {value: () => 'function matchMedia() { [native code] }'}); } catch (e) {}
})();
