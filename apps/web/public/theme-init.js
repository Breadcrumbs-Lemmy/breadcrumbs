// No-flash theme init. Runs synchronously from a render-blocking <script src>
// in <head> BEFORE the CSS loads, so the correct token set is applied on the
// very first paint. Kept as an external file (not inline) so the production
// Content-Security-Policy can use a strict `script-src 'self'` with no
// 'unsafe-inline'. Must stay tiny and dependency-free.
(function () {
  try {
    var t = localStorage.getItem("bc_theme");
    // "system" or absent: leave data-theme unset so the
    // @media (prefers-color-scheme: dark) block takes over automatically.
    if (t === "light" || t === "dark") {
      document.documentElement.dataset.theme = t;
    }
  } catch (e) {
    // localStorage not available (e.g. private browsing) — default to system.
  }
})();
