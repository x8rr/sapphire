importScripts("/sapphire-sw-router.js");
importScripts("/controller/controller.sw.js");

addEventListener("install", () => self.skipWaiting());
addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

addEventListener("fetch", (e) => {
  if ($sapphireRouter.shouldRoute(e)) {
    e.respondWith($sapphireRouter.route(e));
    return;
  }
  if ($scramjetController.shouldRoute(e)) {
    e.respondWith($scramjetController.route(e));
  }
});
