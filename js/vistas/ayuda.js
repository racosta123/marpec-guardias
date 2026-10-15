// Ayuda: preguntas paso a paso (todos los roles, contenido fijo y búsqueda local), «¿Ya hiciste esto?» y
// «¿Por qué no puede marcar entrada?» (admin y supervisor). SOLO LECTURA: usa las mismas consultas que las demás
// pantallas (las reglas ya acotan al supervisor a sus sitios) y nunca lee PIN, hashes ni secretos. El estado del
// bloqueo del PIN vive solo en el servidor: aquí se explica cómo resolverlo, no se consulta.
import { collection, doc, getDoc, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { diaLargo, hora, hoy, localAMs, lunesDe, sumarDias } from "../tz.js";
import { CATEGORIAS, buscar, preguntasDe } from "../ayuda-contenido.js";
import { cargarSitios } from "./sitios.js";
import { estadoPush } from "../notificaciones.js";

const H = 3600e3;
const VENTANA_DEFECTO_MIN = 30; // mismo valor por defecto que el Worker y la pantalla Empresa

export async function vistaAyuda(raiz, ctx) {
  const oficina = ctx.user.rol !== "guardia";
  limpiar(raiz);
  const cuerpo = h("div", { class: "ayuda-cuerpo", id: "ayuda-panel", ...(oficina ? { role: "tabpanel" } : {}) });
  const partes = oficina ? [["preguntas", "Preguntas"], ["revision", "¿Ya hiciste esto?"], ["marcar", "¿Por qué no puede marcar?"]] : [];
  const pestanas = oficina ? h("div", { class: "ayuda-tabs", role: "tablist", "aria-label": "Partes de la ayuda" },
    partes.map(([clave, texto]) => h("button", { class: "ayuda-tab", type: "button", role: "tab", "aria-controls": "ayuda-panel", "data-clave": clave, onclick: () => abrir(clave) }, texto))) : null;
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Ayuda"),
      ctx.user.rol === "guardia" && ctx.irA ? h("div", { class: "barra-acc" }, h("button", { class: "btn chico secundario", type: "button", onclick: () => ctx.irA("inicio") }, "← Mi turno")) : null),
    pestanas, cuerpo);
  function abrir(clave) {
    if (pestanas) for (const b of pestanas.children) b.setAttribute("aria-selected", String(b.dataset.clave === clave));
    nuevoTurno(cuerpo); // una carga lenta de la pestaña anterior ya no pinta encima de esta
    limpiar(cuerpo);
    if (clave === "revision") return parteRevision(cuerpo, ctx);
    if (clave === "marcar") return parteMarcar(cuerpo, ctx);
    return partePreguntas(cuerpo, ctx);
  }
  abrir("preguntas");
}

// Botón «Ir a ese módulo» (solo si el rol tiene esa sección).
function irBoton(ctx, destino, texto = "Ir a ese módulo") {
  if (!destino || !ctx.irA || !(ctx.secciones || ["inicio"]).includes(destino)) return null;
  return h("button", { class: "btn chico primario", type: "button", onclick: () => ctx.irA(destino) }, texto);
}

// ---------------------------------------------------------------- Parte 1
function partePreguntas(cont, ctx) {
  const todas = preguntasDe(ctx.user.rol);
  const cats = CATEGORIAS[ctx.user.rol === "guardia" ? "guardia" : "oficina"];
  const entrada = h("input", { type: "search", class: "ayuda-buscar", placeholder: "Busca tu duda: turno, PIN, QR…", "aria-label": "Buscar en la ayuda", autocomplete: "off" });
  const lista = h("div", { class: "ayuda-lista" });
  const cuenta = h("p", { class: "visually-hidden", role: "status" });
  const pintar = () => {
    const hallados = buscar(todas, entrada.value);
    limpiar(lista);
    cuenta.textContent = `${hallados.length} pregunta(s) encontrada(s).`;
    if (!hallados.length) { poner(lista, h("p", { class: "vacio" }, "No encontramos esa duda. Prueba con otra palabra o avisa a tu supervisor.")); return; }
    for (const cat of cats) {
      const delCat = hallados.filter((p) => p.cat === cat);
      if (!delCat.length) continue;
      poner(lista, h("section", { class: "ayuda-cat" }, h("h3", {}, cat), delCat.map((p) => h("details", { class: "ayuda-q" },
        h("summary", {}, p.q),
        h("ol", { class: "ayuda-pasos" }, p.pasos.map((x) => h("li", {}, x))),
        p.nota ? h("p", { class: "ayuda" }, p.nota) : null,
        irBoton(ctx, p.ir)))));
    }
  };
  entrada.addEventListener("input", pintar);
  poner(cont, campoBuscar(entrada), cuenta, lista);
  pintar();
}
const campoBuscar = (entrada) => h("label", { class: "campo" }, h("span", { class: "campo-et" }, "Buscar"), entrada);

// ---------------------------------------------------------------- lecturas comunes (mismas consultas que Turnos/Sitios)
const sinRed = (e) => navigator.onLine === false || /unavailable|network|offline/i.test(String(e?.code || e?.message || ""));
async function leerGuardias(db) {
  const s = await getDocs(query(collection(db, "usuarios"), where("rol", "==", "guardia")));
  // Solo los campos que se muestran: nunca PIN, hashes ni otros secretos.
  return { lista: s.docs.map((d) => ({ uid: d.id, nombre: d.data().nombre || "Guardia", numero: d.data().numeroEmpleado || "", activo: d.data().activo === true }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es")), cache: s.metadata?.fromCache === true };
}
async function leerTurnos({ db, user }, desdeMs, hastaMs) {
  const filtroRol = user.rol === "admin" ? [] : [where("supervisorUid", "==", user.uid)];
  const s = await getDocs(query(collection(db, "turnos"), ...filtroRol, where("inicioMs", ">=", desdeMs), where("inicioMs", "<", hastaMs), orderBy("inicioMs")));
  return { lista: s.docs.map((d) => ({ id: d.id, ...d.data() })), cache: s.metadata?.fromCache === true };
}
async function leerPuntos({ db, user }) {
  const col = collection(db, "puntos");
  const s = await getDocs(user.rol === "admin" ? col : query(col, where("supervisorUid", "==", user.uid)));
  return { lista: s.docs.map((d) => ({ sitioId: d.data().sitioId, activo: d.data().activo !== false })), cache: s.metadata?.fromCache === true };
}
// Alcance: el admin ve a todos; el supervisor SOLO a los guardias que tuvieron o tienen turno en SUS sitios (las reglas le
// dejan listar a todos los guardias para asignar turnos, pero la Ayuda no le muestra a los de otros supervisores).
const SEMANAS_ALCANCE = 4;
const enAlcance = (ctx, guardias, turnosSup) => ctx.user.rol === "admin" ? guardias : guardias.filter((g) => turnosSup.some((t) => t.guardiaUid === g.uid));
// Evita que una respuesta lenta pinte encima de una consulta más nueva (elegir otro guardia, «Revisar de nuevo»).
const turnoDe = new WeakMap();
const nuevoTurno = (el) => { const n = (turnoDe.get(el) || 0) + 1; turnoDe.set(el, n); return () => turnoDe.get(el) === n; };
const avisoSinRed = () => h("p", { class: "alerta", role: "status" }, "Sin conexión: datos no actuales. Vuelve a abrir esta sección cuando tengas internet.");

// Fila de verificación: ✅ / ⚠️ / ℹ️ con explicación y botón al módulo.
function fila(ctx, estado, titulo, texto, destino, extra = null) {
  const marca = { ok: "✅", mal: "⚠️", info: "ℹ️" }[estado];
  return h("li", { class: `item ayuda-check ${estado}` },
    h("div", { class: "item-info" },
      h("strong", {}, h("span", { "aria-hidden": "true" }, `${marca} `), titulo),
      h("span", { class: "visually-hidden" }, estado === "ok" ? "Correcto." : estado === "mal" ? "Pendiente." : "Recordatorio."),
      h("span", { class: "sub" }, texto), extra),
    h("div", { class: "item-acc" }, irBoton(ctx, destino, "Ir")));
}

// ---------------------------------------------------------------- Parte 2
async function parteRevision(cont, ctx) {
  const { db, user, api } = ctx;
  const esAdmin = user.rol === "admin";
  const vigente = nuevoTurno(cont);
  poner(cont, h("p", { class: "vacio" }, "Revisando los datos de tu empresa…"));
  const lunes = lunesDe(hoy());
  const iniSemana = localAMs(lunes), finSemana = localAMs(sumarDias(lunes, 7));
  let datos;
  try {
    const [sitios, guardias, turnos, puntos, config, push] = await Promise.all([
      cargarSitios(ctx), leerGuardias(db), leerTurnos(ctx, localAMs(sumarDias(lunes, -7 * SEMANAS_ALCANCE)), finSemana), leerPuntos(ctx),
      esAdmin ? getDoc(doc(db, "configuracion", "empresa")) : null, Promise.race([estadoPush(api), new Promise((r) => setTimeout(() => r(null), 2500))]).catch(() => null), // no detiene la revisión en celulares lentos
    ]);
    datos = { sitios, guardias, turnos, puntos, config, push };
  } catch (e) {
    if (!vigente()) return;
    limpiar(cont);
    poner(cont, sinRed(e) ? avisoSinRed() : null, h("p", { class: "error" }, "No fue posible leer los datos. Revisa tu conexión e intenta de nuevo."));
    return;
  }
  if (!vigente()) return;
  const { sitios, guardias, turnos, puntos, config, push } = datos;
  const ahora = Date.now();
  const semana = turnos.lista.filter((t) => t.inicioMs >= iniSemana && t.inicioMs < finSemana);
  const activos = sitios.filter((s) => s.activo !== false);
  const conUbic = activos.filter((s) => typeof s.lat === "number" && typeof s.lng === "number" && s.radioM > 0);
  const guardiasActivos = enAlcance(ctx, guardias.lista, turnos.lista).filter((g) => g.activo);
  const vigentes = semana.filter((t) => t.estado !== "cancelado");
  const conTurno = new Set(vigentes.map((t) => t.guardiaUid).filter(Boolean));
  const sinTurno = guardiasActivos.filter((g) => !conTurno.has(g.uid));
  const vacantes = vigentes.filter((t) => !t.guardiaUid && t.finMs > ahora);
  const conPuntos = new Set(puntos.lista.filter((p) => p.activo).map((p) => p.sitioId));
  const sinPuntos = activos.filter((s) => !conPuntos.has(s.id));
  const nombres = (xs, n = 6) => xs.slice(0, n).map((x) => x.nombre).join(", ") + (xs.length > n ? ` y ${xs.length - n} más` : "");
  const sitioDe = (id) => sitios.find((s) => s.id === id)?.nombre || "un sitio";
  const delSup = esAdmin ? "" : " en tus sitios";

  const filas = [
    esAdmin
      ? (config?.exists()
        ? fila(ctx, "ok", "Reglas de la empresa", "Ya se guardó la configuración. Revísala si cambian tus políticas de retardos o relevo.", "empresa")
        : fila(ctx, "mal", "Reglas de la empresa", "Aún usa los valores de fábrica (entrada desde 30 min antes, retardo de 10 min, falta a los 30 min). Revísalos y guarda en Empresa.", "empresa"))
      : fila(ctx, "info", "Reglas de la empresa", "Las define el administrador en el menú Empresa.", null),
    conUbic.length
      ? fila(ctx, conUbic.length === activos.length ? "ok" : "mal", "Sitios con ubicación y radio",
        conUbic.length === activos.length ? `${activos.length} sitio(s) activo(s) con ubicación y radio.` : `Sin ubicación: ${nombres(activos.filter((s) => !conUbic.includes(s)))}. Nadie puede marcar ahí hasta capturarla (Sitios → Editar).`, "sitios")
      : fila(ctx, "mal", "Sitios con ubicación y radio", activos.length ? "Ningún sitio tiene ubicación: captúrala en Sitios → Editar para que se pueda marcar." : esAdmin ? "Aún no hay sitios: créalo en Sitios → «+ Sitio»." : "No tienes sitios asignados: pídelo al administrador.", "sitios"),
    fila(ctx, "info", "QR de cada sitio impreso", "La app no puede saberlo: imprime el «QR de asistencia» de cada sitio y pégalo en el puesto. Si alguien lo regeneró, imprime el nuevo.", "sitios"),
    guardiasActivos.length
      ? fila(ctx, "ok", "Guardias dados de alta", `${guardiasActivos.length} guardia(s) activo(s)${esAdmin ? "" : ` con turnos en tus sitios (últimas ${SEMANAS_ALCANCE} semanas)`}.`, "personal")
      : fila(ctx, "mal", "Guardias dados de alta", esAdmin ? "Aún no hay guardias activos: dalos de alta en Personal → «+ Guardia»." : `Ningún guardia activo ha tenido turno en tus sitios en las últimas ${SEMANAS_ALCANCE} semanas: asígnalos en Turnos.`, "personal"),
    !guardiasActivos.length ? fila(ctx, "info", "Turnos de esta semana", "Primero da de alta a tus guardias.", null)
      : sinTurno.length
        ? fila(ctx, "mal", "Cada guardia con turno esta semana", `Sin turno esta semana${delSup}: ${nombres(sinTurno, 10)}. Sin turno no pueden marcar entrada: asígnalo en Turnos → «+ Agregar turnos».`, "turnos",
          h("ul", { class: "ayuda-nombres" }, sinTurno.slice(0, 30).map((g) => h("li", {}, g.numero ? `${g.nombre} (No. ${g.numero})` : g.nombre))))
        : fila(ctx, "ok", "Cada guardia con turno esta semana", `Todos los guardias activos tienen al menos un turno${delSup}.`, "turnos"),
    vacantes.length
      ? fila(ctx, "mal", "Turnos SIN CUBRIR", `${vacantes.length} turno(s) de esta semana sin guardia (${[...new Set(vacantes.map((t) => sitioDe(t.sitioId)))].join(", ")}). Tócalos en Turnos y asigna un guardia.`, "turnos")
      : fila(ctx, "ok", "Turnos SIN CUBRIR", "No hay turnos pendientes sin guardia esta semana.", "turnos"),
    !activos.length ? fila(ctx, "info", "Puntos de rondín", "Primero crea tus sitios.", null)
      : sinPuntos.length
        ? fila(ctx, "mal", "Puntos de rondín", `Sin puntos: ${nombres(sinPuntos)}. Agrégalos en Sitios → «Puntos y rondín» → «+ Punto» y programa el rondín.`, "sitios")
        : fila(ctx, "ok", "Puntos de rondín", "Todos tus sitios activos tienen puntos de rondín.", "sitios"),
    push === null || (sinRed() && !push.suscrito) ? fila(ctx, "info", "Notificaciones en este dispositivo", "No se pudo revisar ahora. Ábrelo en Alertas con conexión.", "alertas")
      : push.suscrito ? fila(ctx, "ok", "Notificaciones en este dispositivo", "Activadas en este dispositivo.", "alertas")
        : fila(ctx, "mal", "Notificaciones en este dispositivo", !push.soporte ? "Este navegador no admite notificaciones: usa Chrome en Android o la app instalada." : push.ios && !push.instalada ? "En iPhone instala la app en la pantalla de inicio y ábrela desde ahí (iOS 16.4 o superior)." : push.permiso === "denied" ? "Están bloqueadas: actívalas en los ajustes del navegador para este sitio." : "Desactivadas: tócalas en Alertas → «🔔 Activar notificaciones».", "alertas"),
  ];
  const cache = sinRed() || guardias.cache || turnos.cache || puntos.cache;
  limpiar(cont);
  poner(cont, cache ? avisoSinRed() : null,
    h("p", { class: "ayuda" }, `Revisión de solo lectura con los datos actuales${delSup} · semana del ${diaLargo(localAMs(lunes, "12:00"))}.`),
    h("ul", { class: "lista ayuda-checks" }, filas),
    h("button", { class: "btn chico secundario", type: "button", onclick: () => { limpiar(cont); parteRevision(cont, ctx); } }, "↻ Revisar de nuevo"));
}

// ---------------------------------------------------------------- Parte 3
async function parteMarcar(cont, ctx) {
  const { db, user } = ctx;
  const vigente = nuevoTurno(cont);
  poner(cont, h("p", { class: "vacio" }, "Cargando guardias…"));
  let guardias, alcance;
  try {
    const ahora = Date.now();
    const [gs, ts] = await Promise.all([leerGuardias(db), user.rol === "admin" ? { lista: [] } : leerTurnos(ctx, ahora - SEMANAS_ALCANCE * 7 * 24 * H, ahora + 7 * 24 * H)]);
    guardias = gs; alcance = enAlcance(ctx, gs.lista, ts.lista);
  } catch (e) {
    if (!vigente()) return;
    limpiar(cont);
    poner(cont, sinRed(e) ? avisoSinRed() : null, h("p", { class: "error" }, "No fue posible leer la lista de guardias. Revisa tu conexión."));
    return;
  }
  if (!vigente()) return;
  const resultado = h("div", { class: "ayuda-diag", "aria-live": "polite" });
  const sel = h("select", { "aria-label": "Guardia", value: "" }, h("option", { value: "" }, "— Elige un guardia —"),
    alcance.map((g) => h("option", { value: g.uid }, `${g.nombre}${g.numero ? ` · No. ${g.numero}` : ""}${g.activo ? "" : " (baja)"}`)));
  sel.addEventListener("change", () => { const g = alcance.find((x) => x.uid === sel.value); if (g) diagnosticar(resultado, ctx, g); else { nuevoTurno(resultado); limpiar(resultado); } }); // sin guardia: se descarta la revisión en curso
  limpiar(cont);
  poner(cont, (sinRed() || guardias.cache) ? avisoSinRed() : null,
    h("p", { class: "ayuda" }, user.rol === "admin" ? "Elige al guardia y revisamos las causas más comunes." : `Elige al guardia y revisamos las causas más comunes en tus sitios (guardias con turnos en ellos en las últimas ${SEMANAS_ALCANCE} semanas o los próximos 7 días).`),
    h("label", { class: "campo" }, h("span", { class: "campo-et" }, "Guardia"), sel), resultado);
}

async function diagnosticar(dest, ctx, g) {
  const { db, user } = ctx;
  const esAdmin = user.rol === "admin";
  const vigente = nuevoTurno(dest);
  limpiar(dest);
  poner(dest, h("p", { class: "vacio" }, "Revisando…"));
  const ahora = Date.now();
  let turnos, sitios, ventanaMin = VENTANA_DEFECTO_MIN, asis = null;
  try {
    [turnos, sitios] = await Promise.all([leerTurnos(ctx, ahora - 36 * H, ahora + 36 * H), cargarSitios(ctx)]);
    if (esAdmin) { const c = await getDoc(doc(db, "configuracion", "empresa")); if (c.exists() && Number.isFinite(c.data().ventanaEntradaMin)) ventanaMin = c.data().ventanaEntradaMin; }
  } catch (e) {
    if (!vigente()) return;
    limpiar(dest);
    poner(dest, sinRed(e) ? avisoSinRed() : null, h("p", { class: "error" }, "No fue posible revisar. Revisa tu conexión e intenta de nuevo."));
    return;
  }
  const suyos = turnos.lista.filter((t) => t.guardiaUid === g.uid);
  const limite = ahora + 24 * H;
  // Turno que importa: el que está en curso o el siguiente de las próximas 24 h (incluye los que inician tras la medianoche).
  const vivos = suyos.filter((t) => t.estado !== "cancelado" && t.finMs > ahora && t.inicioMs < limite);
  const t = vivos[0] || null;
  const canceladoHoy = suyos.find((x) => x.estado === "cancelado" && x.finMs > ahora && x.inicioMs < limite);
  if (t) { try { const a = await getDoc(doc(db, "asistencias", t.id)); if (a.exists()) asis = a.data(); } catch { /* sin acceso o sin red: se usa la ventana de la empresa */ } }
  if (!vigente()) return;
  const sitio = t ? sitios.find((s) => s.id === t.sitioId) : null;
  const items = [];
  const causa = (estado, titulo, texto, destino) => items.push({ estado, titulo, texto, destino });

  // 1. De baja
  if (!g.activo) causa("mal", "Está dado de baja", esAdmin ? "No puede entrar a la app. Si debe volver, toca «Reactivar» en Personal y asígnale turnos." : "No puede entrar a la app. Pide al administrador que lo reactive.", esAdmin ? "personal" : null);
  else causa("ok", "Cuenta activa", "Su acceso no está dado de baja.", null);
  // 2. PIN bloqueado: solo lo sabe el servidor (no se consulta desde aquí)
  causa("info", "¿PIN bloqueado?", esAdmin
    ? "No se puede ver desde aquí. Si al entrar le dice «acceso bloqueado temporalmente», espera 15 min o ve a Personal → «PIN» → «Desbloquear sin cambiar el PIN»."
    : "No se puede ver desde aquí. Si al entrar le dice «acceso bloqueado temporalmente», espera 15 min o pide al administrador que lo desbloquee.", esAdmin ? "personal" : null);
  // 3. Turno de hoy / cancelado
  if (!t) {
    if (canceladoHoy) causa("mal", "Su turno está cancelado", `El turno de ${diaLargo(canceladoHoy.inicioMs)} ${hora(canceladoHoy.inicioMs)} a ${hora(canceladoHoy.finMs)} se canceló y ya no lo ve. Crea uno nuevo en Turnos.`, "turnos");
    else causa("mal", "Sin turno en las próximas 24 h", `No tiene turno asignado${esAdmin ? "" : " en tus sitios"} en curso ni en las próximas 24 horas. Sin turno no puede marcar: asígnalo en Turnos → «+ Agregar turnos».`, "turnos");
  } else {
    causa("ok", "Tiene turno", `${diaLargo(t.inicioMs)} de ${hora(t.inicioMs)} a ${hora(t.finMs)} en ${t.sitioNombre || sitio?.nombre || "su sitio"}.`, null);
    // 4. Ventana de entrada
    const desde = Number.isFinite(asis?.ventanaEntradaDesdeMs) ? asis.ventanaEntradaDesdeMs : t.inicioMs - ventanaMin * 60000;
    if (asis?.entradaMs) causa("ok", "Ya marcó entrada", `Registró su entrada a las ${hora(asis.entradaMs)}.`, "asistencia");
    else if (ahora < desde) causa("mal", "Aún no se abre su ventana de entrada", `Podrá marcar desde las ${hora(desde)}${Number.isFinite(asis?.ventanaEntradaDesdeMs) || esAdmin ? "" : " (30 min antes, el valor de fábrica; el administrador puede haberlo cambiado)"}. Que espere a esa hora.`, null);
    else causa("ok", "Dentro de la ventana de entrada", `Ya puede marcar (desde las ${hora(desde)}).`, null);
    // 5. Sitio: ubicación y activo
    if (!sitio) causa("info", "Sitio", "No se pudo leer el sitio de este turno.", null);
    else if (sitio.activo === false) causa("mal", "El sitio está inactivo", `«${sitio.nombre}» está marcado como inactivo: nadie puede marcar ahí.${esAdmin ? " Actívalo en Sitios → Editar." : " Pide al administrador que lo active."}`, "sitios");
    else if (typeof sitio.lat !== "number" || typeof sitio.lng !== "number") causa("mal", "Sitio sin ubicación", `«${sitio.nombre}» no tiene ubicación: nadie puede marcar ahí.${esAdmin ? " Captúrala en Sitios → Editar." : " Pide al administrador que la capture."}`, "sitios");
    else if (!(sitio.radioM > 0)) causa("mal", "Sitio sin radio", `«${sitio.nombre}» no tiene radio de perímetro.${esAdmin ? " Captúralo en Sitios → Editar." : " Pide al administrador que lo capture."}`, "sitios");
    else causa("ok", "Sitio con ubicación", `Radio del perímetro: ${sitio.radioM} m. El GPS del celular debe tener mejor precisión que eso.`, null);
  }
  const probable = items.find((x) => x.estado === "mal");
  limpiar(dest);
  poner(dest, (sinRed() || turnos.cache) ? avisoSinRed() : null,
    h("section", { class: `tarjeta ayuda-probable ${probable ? "mal" : "ok"}` },
      h("h3", {}, probable ? `Causa probable: ${probable.titulo}` : "No encontramos un bloqueo en sus datos"),
      h("p", {}, probable ? probable.texto : "Lo más probable es que el problema esté en su celular: fuera del perímetro, GPS impreciso (salir a cielo abierto), QR de otro puesto o sin permiso de cámara/ubicación. Pídele que lea el mensaje que le muestra la app."),
      probable ? irBoton(ctx, probable.destino, "Resolver") : null),
    h("ul", { class: "lista ayuda-checks" }, items.map((x) => fila(ctx, x.estado, x.titulo, x.texto, x.destino))));
}
