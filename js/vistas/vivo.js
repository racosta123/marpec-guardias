// Panel en vivo (supervisor y admin): se actualiza solo con listeners de Firestore, sin botón «Actualizar».
// Cada listener filtra por supervisorUid (las reglas rechazan cualquier consulta que pueda traer sitios ajenos);
// el admin escucha todo. Sin mapas ni librerías externas.
import { collection, onSnapshot, query, where } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { hora, hoy } from "../tz.js";
import { cargarSitios } from "./sitios.js";
import { cumplimiento } from "./rondines.js"; // el MISMO cálculo de cumplimiento de rondines de la sección Rondines (Fase 4)
import { contar, estadoPuestos, eventosRecientes } from "../vivo-estado.js";
import { icono } from "../iconos.js";

const H = 3600e3;
// Ícono y tono por tipo de evento (el significado del color es operativo: verde = correcto, rojo = crítico, ámbar = aviso)
const ICONO = { entrada: ["entrada", "ok"], salida: ["salida", ""], incidencia: ["incidencias", "aviso"], incidencia_alta: ["incidencias", "mal"], visitante: ["visitantes", "info"], panico: ["panico", "mal"], panico_atendido: ["check", "ok"], rondin: ["rondines", "info"], rondin_mal: ["incidencias", "mal"] };
// Ícono por estado del puesto (en lugar de fotos: la app no tiene fotos de los sitios)
const ICONO_PUESTO = { cubierto: "escudo", en_rondin: "rondines", descubierto: "escudoalerta", alerta: "incidencias", panico: "panico", sin_turno: "reloj" };
const fechaCorta = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Hermosillo", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const hace = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `hace ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `hace ${m} min`; };

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

  // Indicador de color (número grande con su explicación); la barra solo aparece cuando hay una proporción que mostrar
  function kpi(clase, ico, titulo, valor, sub, pct) {
    const barra = h("span", { class: "k-barra" }, h("span", {}));
    if (pct !== undefined) barra.firstChild.style.width = `${Math.round(pct * 100)}%`; // por CSSOM (la política de seguridad no permite style="")
    return h("div", { class: `kpi ${clase}` },
      h("span", { class: "ico-caja" }, icono(ico, { tam: 26 })),
      h("span", { class: "k-t" }, titulo),
      h("span", { class: "k-v" }, ...valor),
      ...(Array.isArray(sub) ? sub : [sub]).map((s) => h("span", { class: "k-s" }, s)),
      pct !== undefined ? barra : null);
  }

  function pintar() {
    if (!raiz.isConnected) return;
    const ahora = Date.now();
    const puestos = estadoPuestos({ sitios, turnos: datos.turnos, asistencias: datos.asistencias, rondines: datos.rondines, panicos: datos.panicos, incidencias: datos.incidencias, offline: datos.offline, ahora });
    const c = contar(puestos);
    const eventos = eventosRecientes({ asistencias: datos.asistencias, incidencias: datos.incidencias, visitantes: datos.visitantes, panicos: datos.panicos, rondines: datos.rondines, ahora });
    const activas = puestos.flatMap((p) => p.alertas.map((a) => ({ ...a, sitio: p.nombre }))).sort((x, y) => (x.tipo === "panico" ? 0 : 1) - (y.tipo === "panico" ? 0 : 1) || x.desdeMs - y.desdeMs);
    const sinRed = navigator.onLine === false || Object.values(cache).some(Boolean);
    const panicosActivos = datos.panicos.filter((p) => p.estado === "activa").sort((x, y) => x.tsMs - y.tsMs);
    const descubiertos = puestos.filter((p) => p.estado === "descubierto");
    // Cumplimiento de rondines de HOY (hora de Hermosillo): completos / exigibles, igual que la sección Rondines
    const delDia = datos.rondines.filter((r) => r.fecha === hoy());
    const cum = cumplimiento(delDia);
    const textoCum = !delDia.length ? "Sin rondines programados" : cum.porcentaje === null ? "Cumplimiento hoy: sin rondines vencidos aún" : `Cumplimiento hoy ${cum.porcentaje}%`;
    const cuentaTipo = (t) => activas.filter((a) => a.tipo === t).length;
    const resumenAlertas = [[cuentaTipo("panico"), "pánico", "pánicos"], [cuentaTipo("relevo"), "relevo", "relevos"], [cuentaTipo("incidencia"), "incidencia alta", "incidencias altas"], [cuentaTipo("rondin"), "rondín", "rondines"]]
      .filter(([n]) => n).map(([n, uno, varios]) => `${n} ${n === 1 ? uno : varios}`).join(", ");
    limpiar(raiz);
    poner(raiz,
      h("div", { class: "barra" },
        h("div", { class: "v-titulo" }, h("span", { class: `v-punto ${sinRed ? "mal" : ""}`.trim(), "aria-hidden": "true" }), h("h2", {}, "Operación en vivo")),
        h("div", { class: "v-fecha" }, fechaCorta.format(ahora).replace(/\.(?=,|$)/g, ""), h("b", {}, hora(ahora)),
          h("span", { id: "vivo-conexion", class: `vivo-conexion ${sinRed ? "mal" : "ok"}`, role: "status" }, sinRed ? " ● Sin conexión: datos congelados" : " ● En vivo", ultima ? ` · ${hora(ultima)}` : ""))),
      h("div", { class: "kpis vivo-resumen" },
        kpi("k-verde", "escudo", "Puestos cubiertos", [String(c.cubiertos), h("small", {}, ` de ${c.total}`)], c.total ? `${c.enRondin} en rondín ahora` : "Sin puestos registrados", c.total ? c.cubiertos / c.total : 0),
        kpi(c.descubiertos ? "k-rojo" : "k-gris", "escudoalerta", "Descubiertos", [String(c.descubiertos)], descubiertos.length ? `${descubiertos[0].nombre} desde ${hora(descubiertos[0].sinCubrirDesdeMs)}${descubiertos.length > 1 ? ` y ${descubiertos.length - 1} más` : ""}` : "Ningún puesto descubierto"),
        kpi(activas.length ? "k-ambar" : "k-gris", "alertas", "Alertas activas", [String(activas.length)], resumenAlertas || "Sin alertas"),
        kpi("k-azul", "rondines", "En rondín", [String(c.enRondin)], [c.enRondin === 1 ? "puesto con rondín en curso" : "puestos con rondín en curso", textoCum])),
      panicosActivos.map((p) => h("div", { class: "v-panico", role: "alert" },
        icono("panico", { tam: 30 }),
        h("div", { class: "vpn-txt" }, h("b", {}, "PÁNICO"), `${p.sitioNombre || "Sitio sin identificar"} · ${p.guardiaNombre || "Guardia"} · ${hace(ahora - p.tsMs)}`),
        h("button", { class: "btn", type: "button", onclick: () => window.dispatchEvent(new CustomEvent("atender-panico", { detail: { id: p.id } })) }, "ATENDER", icono("derecha", { tam: 16 })))),
      activas.length ? h("section", { class: "alerta-caja v-alertas" }, h("h3", {}, `Alertas activas (${activas.length})`),
        h("ul", { class: "lista" }, activas.map((a) => h("li", { class: "item alerta-borde" }, h("div", { class: "item-info" }, h("strong", {}, `${a.sitio}: ${a.texto}`), h("span", { class: "sub" }, `desde ${hora(a.desdeMs)}`)), h("div", { class: "item-acc" }, h("span", { class: `etq ${a.tipo === "panico" ? "mal" : "info"}` }, a.tipo === "panico" ? "PÁNICO" : "Alerta")))))) : null,
      h("div", { class: "v-seccion" }, h("h3", { class: "titulo-seccion" }, `Puestos (${puestos.length})`)),
      puestos.length ? h("ul", { class: "vivo-puestos" }, puestos.map((p) => h("li", { class: `vivo-puesto e-${p.estado}`, "data-sitio": p.sitioId },
        h("span", { class: "vp-ico" }, icono(ICONO_PUESTO[p.estado] || "escudo", { tam: 24 })),
        h("div", { class: "vivo-cab" }, h("strong", { class: "vp-nombre" }, p.nombre), h("span", { class: `etq vivo-etq e-${p.estado}` }, p.etiqueta)),
        p.desdeMs ? h("span", { class: "vp-hora" }, hora(p.desdeMs)) : null,
        p.guardia ? h("span", { class: "sub" }, `${p.guardia} · desde ${hora(p.desdeMs)}`) : null,
        p.sinCubrirDesdeMs ? h("span", { class: "sub" }, `Turno vigente sin guardia en el puesto (inició ${hora(p.sinCubrirDesdeMs)})`) : null,
        p.alertas.map((a) => h("span", { class: "vivo-alerta" }, `⚠ ${a.texto}`)),
        p.porRevisar ? h("span", { class: "sub" }, `${p.porRevisar} registro(s) sin conexión por revisar`) : null))) : h("p", { class: "vacio" }, "No hay sitios para vigilar."),
      h("div", { class: "v-seccion" }, h("h3", { class: "titulo-seccion" }, "Últimos eventos")),
      eventos.length ? h("ol", { class: "v-eventos-caja vivo-eventos" }, h("li", { class: "v-ev-cab", "aria-hidden": "true" }, h("span", {}, "Hora"), h("span", {}, "Evento"), h("span", {}, "Puesto")), eventos.map((x) => { const [ico, tono] = ICONO[x.tipo] || ["check", ""]; return h("li", { class: `v-evento t-${x.tipo}` },
        h("span", { class: "t-hora" }, hora(x.tsMs)), h("span", { class: `v-ev-ico ${tono}`.trim() }, icono(ico, { tam: 18 })),
        h("div", { class: "t-txt" }, h("strong", {}, x.texto), x.sin_conexion ? h("span", { class: "etq prueba etq-sc" }, "Sin conexión") : null, h("p", {}, x.sitioNombre))); })) : h("p", { class: "vacio" }, "Sin eventos en las últimas 24 horas."));
  }
  pintar();
  window.addEventListener("online", programar);
  window.addEventListener("offline", programar);
  // Al salir de la sección se cancelan los listeners
  return () => { for (const b of bajas) b(); clearInterval(reloj); window.removeEventListener("online", programar); window.removeEventListener("offline", programar); };
}
