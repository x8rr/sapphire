// Stand-in for a real "Vencord web" bundle: patches the live page the same
// way the real thing would (DOM mutation + a global marker other code can
// detect), running in the page's own MAIN world, not an isolated one.
(() => {
  window.__vencordLoaded = true;
  const banner = document.createElement("div");
  banner.id = "vencord-banner";
  banner.textContent = "patched";
  document.body.appendChild(banner);
})();
