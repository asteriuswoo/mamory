if ("serviceWorker" in navigator) {
  let swReg = null;

  // updateViaCache: "none" makes the browser bypass HTTP cache when checking
  // sw.js itself for changes, regardless of any Cache-Control on that file.
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
    swReg = reg;
    // Force an immediate check for a new sw.js instead of waiting for the
    // browser's normal (slow, throttled) background check. Combined with
    // skipWaiting()/clients.claim() in sw.js, this lets an already-installed
    // home-screen app pick up a new deploy the next time it's opened.
    reg.update().catch(() => {});
  }).catch(() => {});

  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });

  // A home-screen PWA is usually resumed from a frozen background state
  // rather than freshly loaded, so the check above (which only runs once,
  // at load time) is often never re-run. Re-check every time the app comes
  // back to the foreground instead.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && swReg) {
      swReg.update().catch(() => {});
    }
  });
}

window.forceAppRefresh = function () {
  if ("caches" in window) {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
  location.reload();
};
