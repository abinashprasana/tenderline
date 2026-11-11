// Runs before the first paint so the page never flashes the wrong theme. An external file (not inline) so
// the Content-Security-Policy can forbid inline scripts.
(function () {
  try {
    var root = document.documentElement;
    var theme = localStorage.getItem("tenderline.theme");
    if (theme !== "light" && theme !== "dark") {
      theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    root.dataset.theme = theme;
    if (localStorage.getItem("tenderline.transparency") === "reduced") root.dataset.transparency = "reduced";
  } catch (e) {
    /* storage blocked: keep the dark default */
  }
})();
