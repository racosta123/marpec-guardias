// Service worker: solo cachea el "cascarón" estático de la app (HTML/CSS/JS/fuentes/logo).
// NUNCA intercepta ni cachea peticiones al Worker ni a Firebase (credenciales y datos).
const VERSION = "marpec-v3";
const SHELL = [
  "./", "index.html", "privacidad.html", "manifest.webmanifest", "marpec-logo.png",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon-180.png",
  "css/app.css", "js/app.js", "js/config.js", "js/api.js", "js/ui.js", "js/tz.js", "js/qr-page.js",
  "js/vistas/guardia.js", "js/vistas/personal.js", "js/vistas/sitios.js", "js/vistas/turnos.js", "js/vistas/empresa.js", "js/vistas/bitacora.js",
  "js/vendor/firebase.js", "js/vendor/qr.js", "qr.html",
  "fonts/barlow-400.woff2", "fonts/barlow-500.woff2", "fonts/barlow-600.woff2", "fonts/barlow-700.woff2",
  "fonts/barlow-condensed-600.woff2", "fonts/barlow-condensed-700.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // todo lo externo va directo a la red

  // Navegación: red primero, con respaldo offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || caches.match("index.html"))));
    return;
  }
  // Estáticos: red primero (para no servir versiones viejas), caché como respaldo.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
