// Service worker: solo cachea el "cascarón" estático de la app (HTML/CSS/JS/fuentes/logo).
// NUNCA intercepta ni cachea peticiones al Worker ni a Firebase (credenciales y datos).
const VERSION = "marpec-v9";
const SHELL = [
  "./", "index.html", "privacidad.html", "manifest.webmanifest", "marpec-logo.png",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon-180.png",
  "css/app.css", "js/app.js", "js/instalar.js", "js/camara.js", "js/config.js", "js/api.js", "js/ui.js", "js/tz.js", "js/qr-page.js",
  "js/vistas/guardia.js", "js/vistas/personal.js", "js/vistas/sitios.js", "js/vistas/turnos.js", "js/vistas/empresa.js", "js/vistas/bitacora.js", "js/vistas/asistencia.js", "js/vistas/reportes.js", "js/vistas/marcar.js", "js/vistas/rondin.js", "js/vistas/libro.js", "js/vistas/incidencias.js", "js/vistas/visitantes.js", "js/vistas/bitacoras.js", "aviso-visitantes.html", "js/aviso-visitantes.js", "js/vistas/rondines.js", "js/vistas/puntos.js", "js/cola.js", "js/envio.js", "js/panico.js", "js/alertas.js", "js/notificaciones.js", "js/rondin-local.js", "js/vivo-estado.js", "js/vistas/vivo.js", "js/vistas/offline.js", "js/vistas/alertas.js", "js/punto-qr-page.js", "punto-qr.html",
  "js/vendor/firebase.js", "js/vendor/qr.js", "js/vendor/jsqr.js", "qr.html",
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

// ---- Notificaciones push (Fase 6) ----
// El contenido SOLO trae el tipo de alerta y el nombre del sitio (nunca selfies, descripciones ni nombres).
const TITULOS = {
  panico: ["🚨 ALERTA DE PÁNICO", true],
  incidencia_alta: ["⚠️ Incidencia de gravedad alta", false],
  relevo: ["El relevo no llegó", false],
  rondin: ["Rondín no iniciado o incompleto", false],
};
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  const [titulo, fija] = TITULOS[d.t] || ["MARPEC Guardias", false];
  const sitio = typeof d.sitio === "string" && d.sitio ? d.sitio.slice(0, 80) : "sin identificar";
  e.waitUntil(self.registration.showNotification((d.prueba ? "PRUEBA · " : "") + titulo, {
    body: `Sitio: ${sitio}. Abre la app para ver el detalle.`,
    tag: d.t === "panico" ? `panico-${Number(d.ts) || Date.now()}` : String(d.t || "aviso"),
    renotify: true, requireInteraction: fija, icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    vibrate: fija ? [500, 200, 500, 200, 500] : [200], data: { t: d.t || null },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => (cs.length ? cs[0].focus() : self.clients.openWindow("./"))));
});
