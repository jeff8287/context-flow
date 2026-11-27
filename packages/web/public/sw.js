// What stands in for the screen when the server that gives it is not up. The screen is given by a server on this
// machine, and a window of its own (the screen installed as an app) has no address bar to say what went wrong: so
// when a page is asked for and the server does not answer, a page kept here says so, and what to do.
// Nothing else is kept or answered from here: every request goes to the server as it always did.
const KEPT = "context-flow-off-1";
const PAGE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(KEPT).then((cache) => cache.add(new Request(PAGE, { cache: "reload" }))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== KEPT).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(PAGE).then((page) => page ?? Response.error())));
});
