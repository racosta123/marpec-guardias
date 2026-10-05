// Notificaciones Web Push (RFC 8030 + VAPID RFC 8292 + cifrado de contenido RFC 8291 aes128gcm), solo WebCrypto.
// Llaves VAPID: SOLO como secret del Worker (VAPID_PRIVATE_JWK, JWK ECDSA P-256 con d, x, y). La pública se deriva.
// El contenido NUNCA lleva datos sensibles: únicamente el TIPO de alerta y el nombre del sitio. Quien recibe la
// notificación abre la app (con su sesión) para ver el detalle.
// Dependencia inevitable: el mensaje viaja por el servicio push del navegador (Google FCM, Mozilla, Apple, Microsoft);
// por eso va cifrado de extremo a extremo (solo el celular suscrito puede leerlo).
import { b64u, b64uToBytes } from "./crypto.js";
import { commit, deleteDocument, getDocument, runQuery } from "./google.js";

const te = new TextEncoder();
export const EVENTOS_PUSH = ["panico", "incidencia_alta", "relevo", "rondin"];
export const EVENTOS_CONFIGURABLES = ["incidencia_alta", "relevo", "rondin"]; // el pánico siempre se envía

// Solo servicios push de navegadores reales: el Worker nunca llama a una URL arbitraria que envíe un usuario.
const HOSTS_PUSH = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function endpointPermitido(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && u.port === "" && HOSTS_PUSH.some((r) => r.test(u.hostname)) && endpoint.length <= 600;
  } catch { return false; }
}

const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

export function vapidConfigurado(env) {
  try { const j = JSON.parse(env.VAPID_PRIVATE_JWK || ""); return Boolean(j.d && j.x && j.y); } catch { return false; }
}

// Llave pública (65 bytes, base64url) que usa el navegador para suscribirse.
export function clavePublica(env) {
  const j = JSON.parse(env.VAPID_PRIVATE_JWK);
  return b64u(concat(new Uint8Array([4]), b64uToBytes(j.x), b64uToBytes(j.y)));
}

async function cabeceraVapid(env, endpoint) {
  const j = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const cuerpo = `${b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.ALLOWED_ORIGIN || "https://example.invalid" })))}`;
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(cuerpo)); // WebCrypto devuelve r||s (ES256)
  return `vapid t=${cuerpo}.${b64u(firma)}, k=${clavePublica(env)}`;
}

async function hkdf(ikm, salt, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

// RFC 8291: cifra `texto` para la suscripción (p256dh = llave pública del navegador, auth = secreto de 16 bytes).
export async function cifrarPush(texto, p256dh, auth) {
  const uaPub = b64uToBytes(p256dh);
  const authSecret = b64uToBytes(auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(ecdh, authSecret, concat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(te.encode(texto), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([65]), asPub, ct); // rs = 4096
}

export async function idSuscripcion(endpoint) {
  const d = await crypto.subtle.digest("SHA-256", te.encode(endpoint));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function enviarUno(env, sub, payload) {
  if (!endpointPermitido(sub.endpoint)) return { ok: false, descartar: true };
  const cuerpo = await cifrarPush(payload, sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: { authorization: await cabeceraVapid(env, sub.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "3600", urgency: "high" },
    body: cuerpo,
  });
  return { ok: res.ok, descartar: res.status === 404 || res.status === 410 };
}

// Destinatarios AUTORIZADOS: administradores activos y el supervisor ACTUAL del sitio (activo). Cada uno con su opt-in.
async function destinatarios(env, evento, sitio) {
  const subs = [];
  const admins = await runQuery(env, "pushSuscripciones", [{ campo: "rol", op: "EQUAL", valor: "admin" }]);
  subs.push(...admins);
  if (sitio?.supervisorUid) subs.push(...(await runQuery(env, "pushSuscripciones", [{ campo: "uid", op: "EQUAL", valor: sitio.supervisorUid }])));
  const perfiles = new Map();
  const out = [];
  for (const s of subs) {
    if (!perfiles.has(s.uid)) perfiles.set(s.uid, await getDocument(env, `usuarios/${s.uid}`));
    const p = perfiles.get(s.uid);
    const autorizado = p && p.activo === true && ((s.rol === "admin" && p.rol === "admin") || (s.rol === "supervisor" && p.rol === "supervisor" && sitio?.supervisorUid === s.uid));
    if (!autorizado) continue;
    if (evento !== "panico" && s.prefs?.[evento] === false) continue; // el pánico no se puede desactivar
    out.push(s);
  }
  return out;
}

// Envía la alerta a quien corresponde. Nunca lanza: una falla de push no debe tumbar el registro que la originó.
export async function notificar(env, { evento, sitio, sitioId, prueba = false }) {
  try {
    if (!EVENTOS_PUSH.includes(evento) || !vapidConfigurado(env)) return { enviados: 0 };
    const s = sitio || (sitioId ? await getDocument(env, `sitios/${sitioId}`) : null);
    const payload = JSON.stringify({ t: evento, sitio: String(s?.nombre || "").slice(0, 80), ...(prueba ? { prueba: true } : {}), ts: Date.now() });
    const subs = await destinatarios(env, evento, s);
    let enviados = 0;
    await Promise.all(subs.map(async (sub) => {
      try {
        const r = await enviarUno(env, sub, payload);
        if (r.ok) enviados++;
        if (r.descartar) await deleteDocument(env, `pushSuscripciones/${sub.id}`).catch(() => {});
      } catch (e) { console.error("push", e?.message); }
    }));
    return { enviados };
  } catch (e) {
    console.error("notificar", e?.message);
    return { enviados: 0 };
  }
}

// Evita notificar dos veces lo mismo (el cron recalcula cada 5 min): pushEnviados/{clave} se crea una sola vez.
export async function notificarUnaVez(env, clave, args) {
  try {
    await commit(env, [{ path: `pushEnviados/${clave}`, data: { evento: args.evento, ...(args.prueba ? { prueba: true } : {}) }, mustNotExist: true, serverTimeField: "ts" }]);
  } catch (e) {
    if (e?.status === 409) return { enviados: 0, repetida: true };
    console.error("pushEnviados", e?.message);
    return { enviados: 0 };
  }
  return notificar(env, args);
}
