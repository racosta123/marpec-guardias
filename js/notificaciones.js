// Notificaciones push (Web Push + VAPID) para supervisor y admin: opt-in desde su panel.
// La llave pública VAPID la entrega el Worker; la privada vive solo como secret del Worker.
// Dependencia inevitable: el aviso viaja por el servicio push del navegador (Google/Firefox/Apple) cifrado de extremo a
// extremo; en iPhone requiere iOS 16.4 o superior Y la app instalada en la pantalla de inicio.
export const EVENTOS = [
  ["incidencia_alta", "Incidencia de gravedad alta"],
  ["relevo", "El relevo no llegó"],
  ["rondin", "Rondín no iniciado o incompleto"],
];

export const pushSoportado = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const esIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const instalada = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function b64uABytes(b64u) {
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64u.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function suscripcionActual() {
  // sin service worker registrado «ready» no se resuelve nunca: se acota la espera
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("El servicio de la app aún no está listo. Recarga e inténtalo de nuevo.")), 6000))]);
  return { reg, sub: await reg.pushManager.getSubscription() };
}

// Estado para pintar el panel: soporte, permiso del navegador, si este dispositivo está suscrito y sus preferencias.
export async function estadoPush(api) {
  const e = { soporte: pushSoportado(), ios: esIos(), instalada: instalada(), permiso: pushSoportado() ? Notification.permission : "denied", suscrito: false, prefs: null, configurado: true };
  if (!e.soporte) return e;
  try {
    const { sub } = await suscripcionActual();
    if (sub) {
      const r = await api("/push/estado", { body: { endpoint: sub.endpoint } });
      e.suscrito = r.suscrito; e.prefs = r.prefs; e.configurado = r.configurado;
    }
  } catch { /* sin conexión: se muestra lo que se sabe */ }
  return e;
}

export async function activarPush(api, prefs) {
  if (!pushSoportado()) throw new Error("Este navegador no admite notificaciones push.");
  if (esIos() && !instalada()) throw new Error("En iPhone primero instala la app (Compartir → Añadir a pantalla de inicio) y ábrela desde ahí. Requiere iOS 16.4 o superior.");
  const permiso = await Notification.requestPermission(); // debe llamarse desde un toque del usuario
  if (permiso !== "granted") throw new Error("Las notificaciones están bloqueadas. Actívalas en los ajustes del navegador para este sitio.");
  const { publicKey } = await api("/push/clave", { method: "GET" });
  const { reg, sub: previa } = await suscripcionActual();
  const sub = previa || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uABytes(publicKey) }));
  const j = sub.toJSON();
  await api("/push/suscribir", { body: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, prefs } });
}

export async function desactivarPush(api) {
  const { sub } = await suscripcionActual();
  if (!sub) return;
  await api("/push/baja", { body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export const guardarPrefs = (api, prefs) => api("/push/prefs", { body: { prefs } });
