// Applies the saved light/dark choice before the page paints. Choice is saved on this device only.
(function () {
  var KEY = 'coop-theme', root = document.documentElement, mq = null;
  try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch (e) { /* ignore */ }
  function saved() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'system' ? v : 'dark'; } catch (e) { return 'dark'; } }
  function resolve(c) { return c === 'system' ? (mq && mq.matches ? 'light' : 'dark') : c; }
  function apply(c) { root.setAttribute('data-theme', resolve(c)); }
  apply(saved());
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (saved() === 'system') apply('system'); });
  window.coopTheme = {
    get: saved,
    set: function (c) { if (c !== 'light' && c !== 'system') c = 'dark'; try { localStorage.setItem(KEY, c); } catch (e) { /* ignore */ } apply(c); }
  };
})();
