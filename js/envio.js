// Envío de registros del guardia con respaldo SIN INTERNET: se intenta en línea y, si no hay conexión, se guarda en la
// cola local y se envía solo al volver la señal (y al abrir la app). Cada registro lleva un clientId único: si la
// respuesta se pierde y se reintenta, el servidor lo reconoce y no lo duplica. Muestra «X registros pendientes de enviar».
import { ahoraEstimado, alCambiar, descartar, encolar, listar, procesar } from "./cola.js";
import { h, limpiar, modal, poner, toast } from "./ui.js";
import { fechaHora } from "./tz.js";

let ctx = null; // { api, uid }
let temporizador = null;
let quitar = [];

const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "") : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`).slice(0, 40);

export function iniciarEnvio({ api, uid }) {
  detenerEnvio();
  ctx = { api, uid };
  const intentar = () => { if (ctx && navigator.onLine !== false) enviarPendientes(); };
  const alVolver = () => { if (document.visibilityState === "visible") intentar(); };
  window.addEventListener("online", intentar);
  document.addEventListener("visibilitychange", alVolver);
  temporizador = setInterval(intentar, 30000);
  quitar = [() => window.removeEventListener("online", intentar), () => document.removeEventListener("visibilitychange", alVolver), () => clearInterval(temporizador)];
  intentar(); // al abrir la app
}
export function detenerEnvio() { for (const q of quitar) q(); quitar = []; ctx = null; }

export async function enviarPendientes({ avisarResultado = false } = {}) {
  if (!ctx) return null;
  const r = await procesar(ctx.api, ctx.uid);
  if (avisarResultado || r.enviados || r.rechazados) {
    if (r.enviados) toast(`${r.enviados} registro(s) enviado(s).`);
    if (r.rechazados) toast(`${r.rechazados} registro(s) fueron rechazados por el servidor. Revisa la lista de pendientes.`, "error");
    if (avisarResultado && r.detenido) toast("Aún no hay conexión con el servidor. Se intentará de nuevo solo.", "error");
  }
  return r;
}

// Envía un registro. Devuelve { encolado:false, data } si llegó al servidor o { encolado:true } si quedó en la cola local.
// Un rechazo del servidor (validación, QR inválido, fuera de perímetro…) se lanza como error: NO se encola.
export async function enviarRegistro({ ruta, body, tipo, resumen, turnoId = null, meta = null }) {
  if (!ctx) throw new Error("Sesión no iniciada.");
  const clientId = nuevoId();
  const horaDispositivoMs = Date.now();
  const horaEstimadaMs = ahoraEstimado();
  const guardarLocal = async () => {
    const item = await encolar({ id: clientId, uid: ctx.uid, tipo, ruta, resumen, turnoId, meta, horaDispositivoMs, horaEstimadaMs, body: { ...body, sync: { clientId, offline: true, horaDispositivoMs, horaEstimadaMs } } });
    return { encolado: true, item };
  };
  if (navigator.onLine === false) return guardarLocal();
  try {
    return { encolado: false, data: await ctx.api(ruta, { body: { ...body, sync: { clientId } } }) };
  } catch (e) {
    if (e && e.status) throw e; // el servidor respondió: es un rechazo real, no un problema de conexión
    return guardarLocal();
  }
}

// ---------------------------------------------------------------- indicador
const ETIQUETA = { entrada: "Entrada", salida: "Salida", rondin: "Rondín", incidencia: "Incidencia", novedad: "Novedad", visitante_entrada: "Entrada de visitante", visitante_salida: "Salida de visitante", panico: "ALERTA DE PÁNICO" };

export function montarBarraSync(contenedor) {
  const pintar = async () => {
    const items = ctx ? (await listar()).filter((x) => x.uid === ctx.uid) : [];
    const pend = items.filter((x) => x.estado === "pendiente");
    const rech = items.filter((x) => x.estado === "rechazado");
    const sinRed = navigator.onLine === false;
    limpiar(contenedor);
    contenedor.hidden = !(pend.length || rech.length || sinRed);
    contenedor.className = `barra-sync ${rech.length ? "mal" : sinRed ? "aviso" : "info"}`;
    if (contenedor.hidden) return;
    poner(contenedor,
      sinRed ? h("span", { class: "sync-red" }, "📵 Sin conexión · ") : null,
      pend.length ? h("strong", { id: "sync-pendientes" }, `${pend.length} registro${pend.length === 1 ? "" : "s"} pendiente${pend.length === 1 ? "" : "s"} de enviar`) : null,
      rech.length ? h("strong", {}, `${pend.length ? " · " : ""}${rech.length} rechazado${rech.length === 1 ? "" : "s"}`) : null,
      !pend.length && !rech.length ? h("span", {}, "puedes seguir trabajando; tus registros se enviarán solos al volver la señal.") : null,
      (pend.length || rech.length) ? h("button", { class: "btn chico secundario", type: "button", onclick: () => abrirLista() }, "Ver") : null,
      pend.length && !sinRed ? h("button", { class: "btn chico secundario", type: "button", onclick: () => enviarPendientes({ avisarResultado: true }) }, "Enviar ahora") : null);
  };
  quitar.push(alCambiar(pintar));
  window.addEventListener("online", pintar);
  window.addEventListener("offline", pintar);
  quitar.push(() => { window.removeEventListener("online", pintar); window.removeEventListener("offline", pintar); });
  pintar();
  return pintar;
}

async function abrirLista() {
  const cont = h("div", {});
  const m = modal("Registros pendientes de enviar", cont);
  async function pintar() {
    const items = ctx ? (await listar()).filter((x) => x.uid === ctx.uid) : [];
    limpiar(cont);
    if (!items.length) { poner(cont, h("p", { class: "vacio" }, "No hay registros pendientes.")); return; }
    poner(cont,
      h("p", { class: "ayuda" }, "Se envían solos, en orden, cuando hay conexión. La hora que quedará es la que tenía tu celular al capturarlos (corregida con la última sincronización)."),
      h("ul", { class: "lista" }, items.map((x) => h("li", { class: "item" },
        h("div", { class: "item-info" }, h("strong", {}, `${ETIQUETA[x.tipo] || x.tipo}${x.resumen && x.resumen !== ETIQUETA[x.tipo] ? ` · ${x.resumen}` : ""}`),
          h("span", { class: "sub" }, `Capturado ${fechaHora(x.horaEstimadaMs)}${x.estado === "pendiente" ? (x.intentos ? ` · ${x.intentos} intento(s)` : "") : ""}`),
          x.estado === "rechazado" ? h("span", { class: "error" }, `Rechazado: ${x.error}`) : null),
        h("div", { class: "item-acc" },
          h("span", { class: `etq ${x.estado === "rechazado" ? "mal" : "info"}` }, x.estado === "rechazado" ? "Rechazado" : "Pendiente"),
          x.estado === "rechazado" ? h("button", { class: "btn chico secundario", type: "button", onclick: async () => { await descartar(x.seq); pintar(); } }, "Descartar") : null)))),
      navigator.onLine === false ? null : h("button", { class: "btn primario", type: "button", onclick: async (e) => { e.currentTarget.disabled = true; await enviarPendientes({ avisarResultado: true }); await pintar(); } }, "Enviar ahora"));
  }
  const quitarOyente = alCambiar(pintar);
  pintar();
  void m; void quitarOyente;
}
