// Libro del guardia (Fase 5): novedades, incidencias (hasta 3 fotos en vivo), visitantes y bitácora del turno.
// Todo se envía al Worker (hora del servidor); aquí solo se captura y se muestra.
import { abrirCamara, capturarSelfie, detener, mostrarEnVideo, pedirUbicacion } from "../camara.js";
import { enviarRegistro } from "../envio.js";
import { listar, metaGet, metaSet } from "../cola.js";
import { accion, campo, h, limpiar, modal, poner, toast } from "../ui.js";
import { hora } from "../tz.js";

const SIN_CONEXION = "Sin conexión: esta consulta necesita internet.";
const GUARDADO_LOCAL = "Guardado SIN CONEXIÓN. Se enviará solo al volver la señal; el servidor lo validará.";
const MOTIVOS = [["visita", "Visita"], ["proveedor", "Proveedor"], ["paqueteria", "Paquetería"], ["servicio", "Servicio"], ["otro", "Otro"]];
const ICONO = { entrada: "🟢", novedad: "📝", rondin: "🔁", incidencia: "⚠️", visitante_entrada: "🚶", visitante_salida: "↩️", salida: "🔴" };

// Foto con la cámara EN VIVO (sin galería). Devuelve { base64, url } o null si se cancela.
export function tomarFoto(facing = "environment", titulo = "Toma la foto") {
  return new Promise((resolve) => {
    const video = h("video", { class: "marcar-video", autoplay: true, playsinline: true, muted: true });
    const msg = h("p", { class: "marcar-estado", role: "status" }, "Apunta con la cámara y toma la foto.");
    const tomar = h("button", { class: "btn primario", type: "button" }, "📸 Tomar foto");
    let stream = null;
    const fin = (r) => { if (stream) detener(stream); m.cerrar(); resolve(r); };
    const m = modal(titulo, h("div", { class: "form" }, video, msg, tomar, h("button", { class: "btn secundario", type: "button", onclick: () => fin(null) }, "Cancelar")));
    abrirCamara(facing).then(async (s) => { stream = s; await mostrarEnVideo(video, s); }).catch((e) => { msg.textContent = e.message; msg.className = "marcar-estado mal"; tomar.disabled = true; });
    tomar.addEventListener("click", async () => {
      try { const f = await capturarSelfie(video); fin(f); } catch (e) { msg.textContent = e.message; msg.className = "marcar-estado mal"; }
    });
  });
}

// ---------------------------------------------------------------- novedad
export function abrirNovedad({ turno, api, alTerminar }) {
  const texto = h("textarea", { rows: 5, maxlength: 1000, required: true, placeholder: "Qué pasó, qué observaste, qué hiciste…" });
  const f = h("form", { class: "form", novalidate: true }, campo("Novedad", texto, "Queda en la bitácora del turno con la hora del servidor y no se puede editar."),
    h("button", { class: "btn primario", type: "submit" }, "Guardar novedad"));
  const m = modal("Nueva novedad", f);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await accion(f.querySelector("button"), () => enviarRegistro({ ruta: "/novedades", tipo: "novedad", resumen: "Novedad", turnoId: turno.id, body: { turnoId: turno.id, texto: texto.value } }));
    if (r) { toast(r.encolado ? GUARDADO_LOCAL : "Novedad registrada."); m.cerrar(); alTerminar(); }
  });
}

// ---------------------------------------------------------------- incidencia
export async function abrirIncidencia({ turno, api, alTerminar }) {
  let catalogo;
  try { catalogo = await api("/catalogo/incidencias", { method: "GET" }); metaSet("catalogoIncidencias", catalogo); }
  catch (e) {
    catalogo = e.status ? null : await metaGet("catalogoIncidencias"); // sin conexión: el último catálogo visto
    if (!catalogo) { toast(e.status ? e.message : "Sin conexión y aún no se descargó el catálogo de incidencias. Conéctate una vez para poder reportar sin internet.", "error"); return; }
  }
  const tipo = h("select", { required: true }, catalogo.tipos.map((t) => h("option", { value: t.id }, t.nombre)));
  const gravedad = h("select", { value: "media" }, h("option", { value: "baja" }, "Baja"), h("option", { value: "media" }, "Media"), h("option", { value: "alta" }, "ALTA — requiere atención inmediata"));
  const desc = h("textarea", { rows: 5, maxlength: 1000, required: true, placeholder: "Describe qué ocurrió, dónde y a qué hora." });
  const fotos = [];
  const galeria = h("div", { class: "fotos-inc" });
  const gps = { v: null };
  const gpsTxt = h("small", { class: "ayuda", role: "status" }, "Se intentará adjuntar tu ubicación.");
  const btnFoto = h("button", { class: "btn secundario", type: "button" }, "📷 Agregar foto (máx. 3)");
  const pintar = () => {
    limpiar(galeria);
    fotos.forEach((f, i) => poner(galeria, h("figure", {}, h("img", { src: f.url, alt: `Foto ${i + 1}` }), h("button", { class: "btn chico secundario", type: "button", onclick: () => { URL.revokeObjectURL(f.url); fotos.splice(i, 1); pintar(); } }, "Quitar"))));
    btnFoto.hidden = fotos.length >= 3;
  };
  btnFoto.addEventListener("click", async () => { const f = await tomarFoto("environment", `Foto ${fotos.length + 1} de 3`); if (f) { fotos.push(f); pintar(); } });
  pedirUbicacion({ timeout: 12000 }).then((g) => { gps.v = g; gpsTxt.textContent = `Ubicación adjunta (±${Math.round(g.precisionM)} m).`; }).catch(() => { gpsTxt.textContent = "No se pudo obtener la ubicación; la incidencia se enviará sin ella."; });
  const f = h("form", { class: "form", novalidate: true },
    campo("Tipo de incidencia", tipo), campo("Gravedad", gravedad), campo("Descripción", desc), galeria, btnFoto, gpsTxt,
    h("button", { class: "btn peligro grande", type: "submit" }, "Enviar incidencia"));
  const m = modal("Reportar incidencia", f);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { turnoId: turno.id, tipoId: tipo.value, gravedad: gravedad.value, descripcion: desc.value, horaDispositivoMs: Date.now(), ...(fotos.length ? { fotos: fotos.map((x) => x.base64) } : {}),
      ...(gps.v ? { lat: gps.v.lat, lng: gps.v.lng, precisionM: gps.v.precisionM } : {}) };
    const r = await accion(f.querySelector("button[type=submit]"), () => enviarRegistro({ ruta: "/incidencias", tipo: "incidencia", resumen: `${gravedad.value.toUpperCase()}: ${tipo.selectedOptions[0]?.textContent || ""}`, turnoId: turno.id, body }));
    if (r) { toast(r.encolado ? GUARDADO_LOCAL : "Incidencia enviada. Tu supervisor ya puede verla."); for (const x of fotos) URL.revokeObjectURL(x.url); m.cerrar(); alTerminar(); }
  });
}

// ---------------------------------------------------------------- visitantes
export async function abrirVisitantes({ turno, api, alTerminar }) {
  const cont = h("div", {});
  const m = modal("Visitantes y vehículos", cont);
  async function cargar() {
    limpiar(cont);
    poner(cont, h("p", { class: "vacio" }, "Cargando…"));
    let r;
    let sinRed = false;
    try { r = await api(`/visitantes/dentro?turnoId=${encodeURIComponent(turno.id)}`, { method: "GET" }); metaSet(`dentro:${turno.id}`, r); }
    catch (e) {
      r = e.status ? null : await metaGet(`dentro:${turno.id}`); // sin conexión: la última lista vista
      if (!r) { limpiar(cont); poner(cont, h("p", { class: "error" }, e.status ? e.message : "Sin conexión. Podrás registrar visitantes: se guardan y se envían solos.")); if (!e.status) poner(cont, h("button", { class: "btn primario grande", type: "button", onclick: () => formEntrada() }, "+ REGISTRAR ENTRADA")); return; }
      sinRed = true;
    }
    // Lo capturado sin conexión y aún no enviado: entradas locales (salvo las que ya tienen salida encolada) y salidas encoladas
    const cola = (await listar()).filter((x) => x.turnoId === turno.id && x.estado === "pendiente");
    const salenLocal = new Set(cola.filter((x) => x.tipo === "visitante_salida").map((x) => x.body.visitanteId || x.body.visitanteClientId));
    const locales = cola.filter((x) => x.tipo === "visitante_entrada" && !salenLocal.has(x.id)).map((x) => ({ id: null, clientId: x.id, nombre: x.body.nombre, visitaA: x.body.visitaA, motivo: x.body.motivo, empresa: x.body.empresa, placas: x.body.placas, entradaMs: x.horaEstimadaMs, pendiente: true }));
    r = { ...r, dentro: [...r.dentro.filter((v) => !salenLocal.has(v.id)), ...locales] };
    limpiar(cont);
    poner(cont,
      h("button", { class: "btn primario grande", type: "button", onclick: () => formEntrada() }, "+ REGISTRAR ENTRADA"),
      sinRed ? h("p", { class: "alerta" }, "Sin conexión: se muestra la última lista conocida más lo que registres ahora.") : null,
      h("h3", { class: "titulo-seccion" }, `Dentro del sitio ahora (${r.dentro.length})`),
      r.dentro.length ? h("ul", { class: "lista" }, r.dentro.map((v) => h("li", { class: "item" }, h("div", { class: "item-info" },
        h("strong", {}, v.nombre), h("span", { class: "sub" }, `Visita a ${v.visitaA} · ${(MOTIVOS.find((x) => x[0] === v.motivo) || [0, v.motivo])[1]}${v.empresa ? " · " + v.empresa : ""}${v.placas ? " · placas " + v.placas : ""}`),
        h("span", { class: "sub" }, `Entró a las ${hora(v.entradaMs)}${v.guardiaNombre ? " (registró " + v.guardiaNombre + ")" : ""}`), v.pendiente ? h("span", { class: "etq info" }, "Pendiente de enviar") : null),
      h("div", { class: "item-acc" }, h("button", { class: "btn chico secundario", type: "button", onclick: async (e) => {
        const ok = await accion(e.currentTarget, () => enviarRegistro({ ruta: "/visitantes/salida", tipo: "visitante_salida", resumen: v.nombre, turnoId: turno.id, body: { turnoId: turno.id, ...(v.id ? { visitanteId: v.id } : { visitanteClientId: v.clientId }) } }));
        if (ok) { toast(ok.encolado ? GUARDADO_LOCAL : `Salida de ${v.nombre} registrada.`); cargar(); }
      } }, "Registrar salida")))))
        : h("p", { class: "vacio" }, "No hay visitantes dentro."));
  }
  function formEntrada() {
    limpiar(cont);
    const nombre = h("input", { type: "text", maxlength: 80, required: true, autocomplete: "off" });
    const visita = h("input", { type: "text", maxlength: 80, required: true, placeholder: "Casa / persona / área" });
    const motivo = h("select", { value: "visita" }, MOTIVOS.map(([v, e]) => h("option", { value: v }, e)));
    const empresa = h("input", { type: "text", maxlength: 80 });
    const placas = h("input", { type: "text", maxlength: 12, autocapitalize: "characters", placeholder: "ABC-123" });
    let foto = null;
    const fotoCaja = h("div", {});
    const pintar = () => { limpiar(fotoCaja); if (foto) poner(fotoCaja, h("img", { class: "marcar-prev", src: foto.url, alt: "Foto" }), h("button", { class: "btn chico secundario", type: "button", onclick: () => { URL.revokeObjectURL(foto.url); foto = null; pintar(); } }, "Quitar foto"));
      else poner(fotoCaja, h("button", { class: "btn secundario", type: "button", onclick: async () => { const f = await tomarFoto("environment", "Foto del vehículo o la placa"); if (f) { foto = f; pintar(); } } }, "📷 Foto del vehículo o la placa (opcional)")); };
    pintar();
    const f = h("form", { class: "form", novalidate: true },
      h("p", { class: "aviso-id" }, "🚫 No pidas ni fotografíes identificaciones (INE, licencia, pasaporte) ni anotes sus números."),
      campo("Nombre del visitante", nombre), campo("A quién visita", visita), campo("Motivo", motivo), campo("Empresa (opcional)", empresa), campo("Placas (opcional)", placas), fotoCaja,
      h("button", { class: "btn primario", type: "submit" }, "Registrar entrada"), h("button", { class: "btn secundario", type: "button", onclick: cargar }, "Cancelar"));
    poner(cont, f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { turnoId: turno.id, nombre: nombre.value, visitaA: visita.value, motivo: motivo.value, empresa: empresa.value, placas: placas.value, ...(foto ? { foto: foto.base64 } : {}) };
      const r = await accion(f.querySelector("button[type=submit]"), () => enviarRegistro({ ruta: "/visitantes/entrada", tipo: "visitante_entrada", resumen: nombre.value.trim(), turnoId: turno.id, body }));
      if (r) { toast(r.encolado ? GUARDADO_LOCAL : "Entrada registrada."); if (foto) URL.revokeObjectURL(foto.url); cargar(); alTerminar(); }
    });
  }
  cargar();
  void m;
}

// ---------------------------------------------------------------- bitácora (línea de tiempo)
export function lineaDeTiempo(b) {
  return h("div", {},
    h("p", { class: "sub" }, `${b.sitioNombre} · ${b.guardiaNombre} · ${hora(b.inicioMs)}–${hora(b.finMs)}`),
    b.items.length ? h("ol", { class: "tiempo" }, b.items.map((x) => h("li", { class: `t-${x.tipo} ${x.gravedad === "alta" ? "t-alta" : ""}` },
      h("span", { class: "t-hora" }, hora(x.tsMs)), h("span", { class: "t-icono" }, ICONO[x.tipo] || "•"),
      h("div", { class: "t-txt" }, h("strong", {}, x.titulo), x.sin_conexion ? h("span", { class: "etq prueba etq-sc" }, "Sin conexión") : null, x.detalle ? h("p", {}, x.detalle) : null)))) : h("p", { class: "vacio" }, "Sin movimientos en este turno."),
    b.visitantesDentro?.length ? h("p", { class: "alerta" }, `Siguen dentro del sitio: ${b.visitantesDentro.map((v) => `${v.nombre} (desde ${hora(v.entradaMs)})`).join(", ")}.`) : null);
}

export async function abrirBitacora({ turno, api }) {
  const cont = h("div", {}, h("p", { class: "vacio" }, "Cargando bitácora…"));
  modal("Bitácora del turno", cont);
  try {
    const [actual, anterior] = await Promise.all([
      api(`/bitacora/turno?turnoId=${encodeURIComponent(turno.id)}`, { method: "GET" }),
      api(`/bitacora/anterior?turnoId=${encodeURIComponent(turno.id)}`, { method: "GET" }).catch(() => ({ hay: false })),
    ]);
    limpiar(cont);
    poner(cont, h("h3", { class: "titulo-seccion" }, "Este turno"), lineaDeTiempo(actual),
      anterior.hay ? [h("h3", { class: "titulo-seccion" }, "Turno anterior del sitio"), lineaDeTiempo(anterior.bitacora)] : h("p", { class: "ayuda" }, "No hay un turno anterior registrado para este sitio."));
  } catch (e) { limpiar(cont); poner(cont, h("p", { class: "error" }, e.status ? e.message : SIN_CONEXION)); }
}
