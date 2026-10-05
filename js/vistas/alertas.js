// Alertas (supervisor y admin): notificaciones push (opt-in) con sus preferencias e historial de alertas de pánico.
import { collection, getDocs, limit, orderBy, query, where } from "../vendor/firebase.js";
import { accion, h, limpiar, poner, toast } from "../ui.js";
import { fechaHora } from "../tz.js";
import { EVENTOS, activarPush, desactivarPush, estadoPush, guardarPrefs } from "../notificaciones.js";

export async function vistaAlertas(raiz, ctx) {
  const { db, api, user } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando…"));
  const col = collection(db, "panicoVista");
  const q = user.rol === "admin" ? query(col, orderBy("tsMs", "desc"), limit(30)) : query(col, where("supervisorUid", "==", user.uid), orderBy("tsMs", "desc"), limit(30));
  const [snap, est] = await Promise.all([getDocs(q), estadoPush(api)]);
  const hist = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const recargar = () => vistaAlertas(raiz, ctx);

  // ---- notificaciones push ----
  const prefs = { incidencia_alta: true, relevo: true, rondin: true, ...(est.prefs || {}) };
  const marcas = EVENTOS.map(([clave, texto]) => {
    const c = h("input", { type: "checkbox", checked: prefs[clave] !== false, "aria-label": texto, onchange: async () => {
      prefs[clave] = c.checked;
      try { await guardarPrefs(api, prefs); toast("Preferencias guardadas."); } catch (e) { toast(e.message, "error"); c.checked = !c.checked; prefs[clave] = c.checked; }
    } });
    return h("label", { class: "check" }, c, ` ${texto}`);
  });
  let estadoTxt, accionPush;
  if (!est.soporte) estadoTxt = "Este navegador no admite notificaciones push.";
  else if (est.ios && !est.instalada) estadoTxt = "En iPhone las notificaciones solo funcionan con la app instalada en la pantalla de inicio (iOS 16.4 o superior): Compartir → Añadir a pantalla de inicio, y abre la app desde ahí.";
  else if (est.permiso === "denied") estadoTxt = "Las notificaciones están bloqueadas en este navegador. Actívalas en los ajustes del sitio.";
  else if (est.suscrito) estadoTxt = "✔ Activadas en este dispositivo.";
  else estadoTxt = "Desactivadas en este dispositivo.";
  if (est.soporte && !(est.ios && !est.instalada) && est.permiso !== "denied") {
    accionPush = est.suscrito
      ? h("button", { class: "btn secundario", type: "button", onclick: async (e) => { await accion(e.currentTarget, () => desactivarPush(api), "Notificaciones desactivadas en este dispositivo."); recargar(); } }, "Desactivar en este dispositivo")
      : h("button", { class: "btn primario", type: "button", onclick: async (e) => { await accion(e.currentTarget, () => activarPush(api, prefs), "Notificaciones activadas."); recargar(); } }, "🔔 Activar notificaciones");
  }

  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Alertas"), h("div", { class: "barra-acc" }, h("button", { class: "btn chico secundario", type: "button", onclick: recargar }, "↻ Actualizar"))),
    h("section", { class: "tarjeta" },
      h("h3", { class: "titulo-seccion" }, "Notificaciones en este dispositivo"),
      h("p", { id: "push-estado", role: "status" }, estadoTxt), accionPush,
      h("p", { class: "ayuda" }, "El pánico siempre se notifica (no se puede desactivar). Elige qué otras alertas quieres recibir:"),
      h("div", { class: "form" }, marcas),
      h("p", { class: "ayuda" }, "La notificación solo dice el TIPO de alerta y el sitio; el detalle lo ves al abrir la app con tu sesión. Los avisos viajan cifrados por el servicio de notificaciones de tu navegador (Google, Mozilla o Apple): es una dependencia inevitable de la tecnología push. Con la app cerrada o sin internet en tu teléfono, no llegan.")),
    h("h3", { class: "titulo-seccion" }, "Historial de alertas de pánico"),
    hist.length ? h("ul", { class: "lista" }, hist.map((a) => h("li", { class: `item ${a.estado === "activa" ? "alerta-borde" : ""}` },
      h("div", { class: "item-info" },
        h("strong", {}, `${a.sitioNombre || "Sin sitio"} · ${a.guardiaNombre}`),
        h("span", { class: "sub" }, `${fechaHora(a.tsMs)}${a.sin_conexion ? ` · capturada sin conexión, recibida ${fechaHora(a.recibidoMs)}` : ""}${a.lat != null ? ` · ${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}` : " · sin ubicación"}`),
        a.estado === "atendida" ? h("span", { class: "sub" }, `Atendida por ${a.atendidaPorNombre} (${a.atendidaPorRol}) · ${fechaHora(a.atendidaMs)}${a.notaAtencion ? ` · ${a.notaAtencion}` : ""}`) : null),
      h("div", { class: "item-acc" }, h("span", { class: `etq ${a.estado === "activa" ? "mal" : "ok"}` }, a.estado === "activa" ? "ACTIVA" : "Atendida"), a.prueba ? h("span", { class: "etq prueba" }, "PRUEBA") : null))))
      : h("p", { class: "vacio" }, "Sin alertas de pánico registradas."));
}
