// Lets phones install the CRM as an app (Add to Home Screen). Pages always come
// from the server, so nothing goes stale; with no signal, a short note shows instead.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;padding:2rem">'
    + '<h2>No connection</h2><p>Check your signal or Wi-Fi, then pull down to reload.</p></body>',
    { headers: { 'Content-Type': 'text/html' } })));
});
