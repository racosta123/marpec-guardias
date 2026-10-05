// Panel en vivo (supervisor y admin): se actualiza solo con listeners de Firestore, sin botón «Actualizar».
// Cada listener filtra por supervisorUid (las reglas rechazan cualquier consulta que pueda traer sitios ajenos);
// el admin escucha todo. Sin mapas ni librerías externas.
import { collection, onSnapshot, query, where } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { hora } from "../tz.js";
import { cargarSitios } from "./sitios.js";
import { contar, estadoPuestos, eventosRecientes } from "../vivo-estado.js";

const H = 3600e3;
const ICONO = { entrada: "🟢", salida: "🔴", incidencia: "⚠️", incidencia_alta: "🚨", visitante: "🚶", panico: "🆘", panico_atendido: "✅", rondin: "🔁", rondin_mal: "❗" };

export async function vistaVivo(raiz, ctx) {
  const { db, user } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Conectando en vivo…"));
  const sitios = await cargarSitios(ctx);
  const ahora0 = Date.now();
  const esAdmin = user.rol === "admin";
  const prop = esAdmin ? [] : [where("supervisorUid", "==", user.uid)];
  const datos = { turnos: [], asistencias: [], rondines: [], panicos: [], incidencias: [], visitantes: [], offline: [] };
  const cache = {}; // por colección: ¿el último snapshot vino de la caché local (sin servidor)?
  let ultima = null;
  let pendiente = false;

  const fuentes = [
    ["turnos", "turnos", [where("inicioMs", ">=", ahora0 - 36 * H)]],
    ["asistencias", "asistencias", [where("inicioMs", ">=", ahora0 - 36 * H)]],
    ["rondines", "rondines", [where("programadoMs", ">=", ahora0 - 36 * H)]],
    ["incidencias", "incidenciasResumen", [where("creadoMs", ">=", ahora0 - 48 * H)]],
    ["visitantes", "visitantesVista", [where("entradaMs", ">=", ahora0 - 24 * H)]],
    ["panicos", "panicoVista", [where("tsMs", ">=", ahora0 - 24 * H)]],
    ["offline", "offlineVista", [where("tsMs", ">=", ahora0 - 72 * H)]],
  ];
  const bajas = fuentes.map(([clave, colNombre, filtros]) => onSnapshot(query(collection(db, colNombre), ...prop, ...filtros), (snap) => {
    datos[clave] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cache[clave] = snap.metadata.fromCache;
    ultima = Date.now();
    programar();
  }, () => { cache[clave] = true; programar(); }));

  const programar = () => { if (pendiente) return; pendiente = true; requestAnimationFrame(() => { pendiente = false; pintar(); }); };
  const reloj = setInterval(programar, 30000); // los estados dependen de la hora (turno que empieza, rondín que vence)

  function pintar() {
    if (!raiz.isConnected) return;
    const ahora = Date.now();
    const puestos = estadoPuestos({ sitios, turnos: datos.turnos, asistencias: datos.asistencias, rondines: datos.rondines, panicos: datos.panicos, incidencias: datos.incidencias, offline: datos.offline, ahora });
    const c = contar(puestos);
    const eventos = eventosRecientes({ asistencias: datos.asistencias, incidencias: datos.incidencias, visitantes: datos.visitantes, panicos: datos.panicos, rondines: datos.rondines, ahora });
    const activas = puestos.flatMap((p) => p.alertas.map((a) => ({ ...a, sitio: p.nombre }))).sort((x, y) => (x.tipo === "panico" ? 0 : 1) - (y.tipo === "panico" ? 0 : 1) || x.desdeMs - y.desdeMs);
    const sinRed = navigator.onLine === false || Object.values(cache).some(Boolean);
    limpiar(raiz);
    poner(raiz,
      h("div", { class: "barra" }, h("h2", {}, "En vivo"),
        h("span", { id: "vivo-conexion", class: `vivo-conexion ${sinRed ? "mal" : "ok"}`, role: "status" }, sinRed ? "● Sin conexión: datos congelados" : "● En vivo", ultima ? ` · ${hora(ultima)}` : "")),
      h("div", { class: "cumpl vivo-resumen" },
        [["Cubiertos", c.cubiertos, "ok"], ["Descubiertos", c.descubiertos, c.descubiertos ? "mal" : "ok"], ["En alerta", c.enAlerta, c.enAlerta ? "mal" : "ok"], ["En rondín", c.enRondin, "info"]].map(([t, n, k]) => h("div", { class: "cumpl-item" }, h("span", { class: "sub" }, t), h("span", { class: `cumpl-pct ${k === "ok" ? "ok" : k === "mal" ? "mal" : ""}` }, String(n))))),
      activas.length ? h("section", { class: "alerta-caja" }, h("h3", {}, `Alertas activas (${activas.length})`),
        h("ul", { class: "lista" }, activas.map((a) => h("li", { class: "item alerta-borde" }, h("div", { class: "item-info" }, h("strong", {}, `${a.sitio}: ${a.texto}`), h("span", { class: "sub" }, `desde ${hora(a.desdeMs)}`)), h("div", { class: "item-acc" }, h("span", { class: `etq ${a.tipo === "panico" ? "mal" : "info"}` }, a.tipo === "panico" ? "PÁNICO" : "Alerta")))))) : null,
      h("h3", { class: "titulo-seccion" }, "Puestos"),
      puestos.length ? h("ul", { class: "vivo-puestos" }, puestos.map((p) => h("li", { class: `vivo-puesto e-${p.estado}`, "data-sitio": p.sitioId },
        h("div", { class: "vivo-cab" }, h("strong", {}, p.nombre), h("span", { class: `etq vivo-etq e-${p.estado}` }, p.etiqueta)),
        p.guardia ? h("span", { class: "sub" }, `${p.guardia} · desde ${hora(p.desdeMs)}`) : null,
        p.sinCubrirDesdeMs ? h("span", { class: "sub" }, `Turno vigente sin guardia en el puesto (inició ${hora(p.sinCubrirDesdeMs)})`) : null,
        p.alertas.map((a) => h("span", { class: "vivo-alerta" }, `⚠ ${a.texto}`)),
        p.porRevisar ? h("span", { class: "sub" }, `${p.porRevisar} registro(s) sin conexión por revisar`) : null))) : h("p", { class: "vacio" }, "No hay sitios para vigilar."),
      h("h3", { class: "titulo-seccion" }, "Últimos eventos"),
      eventos.length ? h("ol", { class: "tiempo vivo-eventos" }, eventos.map((x) => h("li", { class: `t-${x.tipo}` }, h("span", { class: "t-hora" }, hora(x.tsMs)), h("span", { class: "t-icono" }, ICONO[x.tipo] || "•"),
        h("div", { class: "t-txt" }, h("strong", {}, x.texto), x.sin_conexion ? h("span", { class: "etq prueba etq-sc" }, "Sin conexión") : null, h("p", {}, x.sitioNombre))))) : h("p", { class: "vacio" }, "Sin eventos en las últimas 24 horas."));
  }
  pintar();
  window.addEventListener("online", programar);
  window.addEventListener("offline", programar);
  // Al salir de la sección se cancelan los listeners
  return () => { for (const b of bajas) b(); clearInterval(reloj); window.removeEventListener("online", programar); window.removeEventListener("offline", programar); };
}
