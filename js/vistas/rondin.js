// Rondín del guardia: escanea el QR de cada punto con la cámara de la app (mismo lector que la asistencia),
// con barra de progreso, nota opcional y foto opcional por punto. El Worker valida todo (QR, turno, GPS, orden).
import { abrirCamara, capturarSelfie, detener, escanearQr, mostrarEnVideo, pedirUbicacion } from "../camara.js";
import { enviarRegistro } from "../envio.js";
import { ahoraEstimado, listar, metaGet, metaSet } from "../cola.js";
import { rondinLocal } from "../rondin-local.js";
import { campo, h, limpiar, poner, toast } from "../ui.js";
import { hora } from "../tz.js";

const FORMATO_QR = /^MPC2\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/;

export function abrirRondin({ turno, api, alTerminar }) {
  const fondo = h("div", { class: "marcar-fondo", role: "dialog", "aria-modal": "true", "aria-label": "Rondín" });
  const caja = h("div", { class: "marcar-caja" });
  fondo.append(caja);
  document.body.append(fondo);
  let stream = null, detenerQr = null, actual = null, sinRed = false;

  const liberar = () => { if (detenerQr) { detenerQr(); detenerQr = null; } if (stream) { detener(stream); stream = null; } };
  const cerrar = () => { liberar(); fondo.remove(); alTerminar(); };
  const cab = (titulo) => h("div", { class: "marcar-cab" },
    h("span", { class: "marcar-paso" }, actual ? `Rondín de las ${hora(actual.programadoMs)}` : "Rondín"),
    h("button", { class: "btn-icono", type: "button", "aria-label": "Cerrar", onclick: cerrar }, "✕"), h("h2", {}, titulo));

  // En línea: lo que dice el servidor (y se guarda copia). Sin conexión: la última copia + lo capturado y aún no enviado.
  async function cargar() {
    let r;
    try {
      r = await api(`/rondines/proximo?turnoId=${encodeURIComponent(turno.id)}`, { method: "GET" });
      const previo = await metaGet(`rondin:${turno.id}`);
      metaSet(`rondin:${turno.id}`, { ...r, plantilla: r.actual ? r.actual.puntos.map(({ puntoId, nombre, orden, descripcion, requiereGps }) => ({ puntoId, nombre, orden, descripcion, requiereGps })) : previo?.plantilla || null });
    } catch (e) {
      if (e.status) throw e;
      const copia = await metaGet(`rondin:${turno.id}`);
      if (!copia) throw new Error("Sin conexión: abre el rondín al menos una vez con internet para poder rondinear sin señal.");
      const cola = (await listar()).filter((x) => x.tipo === "rondin" && x.turnoId === turno.id && x.estado === "pendiente");
      r = rondinLocal(copia, cola, ahoraEstimado());
      sinRed = true;
    }
    if (!r.hay) throw new Error(r.motivo === "sin_entrada" ? "Primero marca tu entrada." : r.motivo === "turno_cerrado" ? "Ya cerraste tu turno." : "Este sitio no tiene rondines programados en tu turno.");
    if (!r.actual) throw new Error(r.proximoMs ? `No hay un rondín en este momento. El siguiente es a las ${hora(r.proximoMs)}.` : "No hay un rondín en este momento.");
    actual = r.actual;
    if (actual && actual.hechos >= actual.total && actual.total > 0) actual.completoLocal = true;
    return r;
  }

  function lista() {
    return h("ul", { class: "puntos-lista" }, actual.puntos.map((p) => h("li", { class: `${p.hecho ? "hecho" : ""} ${actual.siguientePuntoId === p.puntoId ? "siguiente" : ""}` },
      h("span", { class: "punto-marca" }, p.hecho ? "✔" : actual.siguientePuntoId === p.puntoId ? "➜" : "○"),
      h("span", { class: "punto-txt" }, `${p.orden}. ${p.nombre}`),
      h("span", { class: "sub" }, p.hecho ? hora(p.tsMs) : actual.modo === "ordenada" ? "" : ""))));
  }

  async function pantallaEscaneo(mensaje) {
    liberar();
    const video = h("video", { class: "marcar-video", autoplay: true, playsinline: true, muted: true });
    const aviso = h("p", { role: "status", class: `marcar-estado ${mensaje?.mal ? "mal" : ""}` }, mensaje?.texto || (actual.modo === "ordenada" ? `Ruta ordenada: escanea «${actual.puntos.find((p) => p.puntoId === actual.siguientePuntoId)?.nombre || "—"}».` : "Escanea el QR de cualquier punto pendiente."));
    limpiar(caja);
    poner(caja, cab("Escanea los puntos"),
      h("progress", { class: "progreso", max: actual.total, value: actual.hechos, "aria-label": "Progreso del rondín" }),
      h("p", { class: "sub" }, `${actual.hechos} de ${actual.total} puntos${sinRed ? " · SIN CONEXIÓN: se enviarán solos" : ""}`), video, aviso, lista());
    try {
      stream = await abrirCamara("environment");
      await mostrarEnVideo(video, stream);
      let ultimo = "";
      detenerQr = escanearQr(video, (texto) => {
        if (texto === ultimo) return;
        ultimo = texto;
        if (!FORMATO_QR.test(texto)) { aviso.textContent = "Ese código no es un punto de control MARPEC."; aviso.className = "marcar-estado mal"; setTimeout(() => { ultimo = ""; }, 2500); return; }
        const puntoId = texto.split(".")[1];
        const p = actual.puntos.find((x) => x.puntoId === puntoId);
        const rechazo = !p ? "Ese punto no es de tu puesto o no está en este rondín."
          : p.hecho ? `Ya registraste «${p.nombre}» en este rondín.`
            : actual.modo === "ordenada" && actual.siguientePuntoId !== puntoId ? `La ruta es ordenada: el siguiente es «${actual.puntos.find((x) => x.puntoId === actual.siguientePuntoId)?.nombre}».` : null;
        if (rechazo) { aviso.textContent = rechazo; aviso.className = "marcar-estado mal"; setTimeout(() => { ultimo = ""; }, 2500); return; }
        pantallaPunto(texto, p);
      });
    } catch (e) {
      aviso.textContent = e.message; aviso.className = "marcar-estado mal";
      poner(caja, h("button", { class: "btn secundario", type: "button", onclick: () => pantallaEscaneo() }, "Reintentar"));
    }
  }

  async function pantallaPunto(qr, p) {
    liberar();
    const estado = { gps: null, foto: null };
    const gpsTxt = h("p", { role: "status", class: "marcar-estado" }, p.requiereGps ? "Buscando tu ubicación…" : "Este punto no requiere GPS.");
    const nota = h("textarea", { rows: 3, maxlength: 300, placeholder: "Nota (opcional): novedades en este punto" });
    const fotoCaja = h("div", {});
    const error = h("div", {});
    const enviar = h("button", { class: "btn primario grande", type: "button", disabled: p.requiereGps }, "Registrar punto");

    async function ubicar() {
      if (!p.requiereGps) return;
      gpsTxt.textContent = "Buscando tu ubicación…"; gpsTxt.className = "marcar-estado"; enviar.disabled = true;
      try { estado.gps = await pedirUbicacion(); gpsTxt.textContent = `Ubicación capturada (±${Math.round(estado.gps.precisionM)} m).`; gpsTxt.className = "marcar-estado ok"; enviar.disabled = false; }
      catch (e) { gpsTxt.textContent = e.message; gpsTxt.className = "marcar-estado mal"; poner(error, h("button", { class: "btn secundario", type: "button", onclick: () => { limpiar(error); ubicar(); } }, "Reintentar ubicación")); }
    }
    function pintarFoto() {
      limpiar(fotoCaja);
      if (estado.foto) poner(fotoCaja, h("img", { class: "marcar-prev", src: estado.foto.url, alt: "Foto del punto" }), h("button", { class: "btn chico secundario", type: "button", onclick: () => { URL.revokeObjectURL(estado.foto.url); estado.foto = null; pintarFoto(); } }, "Quitar foto"));
      else poner(fotoCaja, h("button", { class: "btn secundario", type: "button", onclick: tomarFoto }, "📷 Agregar foto (opcional)"));
    }
    async function tomarFoto() {
      limpiar(fotoCaja);
      const video = h("video", { class: "marcar-video", autoplay: true, playsinline: true, muted: true });
      const msg = h("p", { class: "marcar-estado" }, "Apunta al punto y toma la foto.");
      const tomar = h("button", { class: "btn primario", type: "button" }, "📸 Tomar foto");
      poner(fotoCaja, video, msg, tomar);
      let s;
      try { s = await abrirCamara("environment"); await mostrarEnVideo(video, s); } catch (e) { msg.textContent = e.message; msg.className = "marcar-estado mal"; poner(fotoCaja, h("button", { class: "btn chico secundario", type: "button", onclick: pintarFoto }, "Cancelar")); return; }
      tomar.addEventListener("click", async () => {
        try { estado.foto = await capturarSelfie(video); } catch (e) { msg.textContent = e.message; msg.className = "marcar-estado mal"; return; }
        detener(s); pintarFoto();
      });
    }

    limpiar(caja);
    poner(caja, cab(p.nombre), p.descripcion ? h("p", { class: "sub" }, p.descripcion) : null, gpsTxt, campo("Nota (opcional)", nota), fotoCaja, enviar, error,
      h("button", { class: "btn secundario", type: "button", onclick: () => pantallaEscaneo() }, "Cancelar y seguir escaneando"));
    pintarFoto();
    ubicar();
    enviar.addEventListener("click", async () => {
      limpiar(error);
      enviar.disabled = true; enviar.textContent = "Registrando…";
      try {
        const res = await enviarRegistro({
          ruta: "/rondines/escanear", tipo: "rondin", resumen: p.nombre, turnoId: turno.id, meta: { puntoId: p.puntoId, puntoNombre: p.nombre },
          body: {
            turnoId: turno.id, qr, nota: nota.value, horaDispositivoMs: Date.now(),
            ...(estado.gps ? { lat: estado.gps.lat, lng: estado.gps.lng, precisionM: estado.gps.precisionM } : {}),
            ...(estado.foto ? { foto: estado.foto.base64 } : {}),
          },
        });
        if (estado.foto) URL.revokeObjectURL(estado.foto.url);
        if (res.encolado) {
          toast(`✔ ${p.nombre} guardado SIN CONEXIÓN; se enviará solo.`);
          await cargar();
          if (!actual || actual.completoLocal) return pantallaCompleto();
          return pantallaEscaneo({ texto: actual.modo === "ordenada" ? `Siguiente: «${actual.puntos.find((x) => x.puntoId === actual.siguientePuntoId)?.nombre || "—"}».` : "Escanea el siguiente punto pendiente." });
        }
        const r = res.data;
        toast(`✔ ${r.punto} (${r.hechos}/${r.total})`);
        if (r.completo) return pantallaCompleto();
        await cargar();
        pantallaEscaneo({ texto: r.siguiente ? `Siguiente: «${r.siguiente}».` : "Escanea el siguiente punto pendiente." });
      } catch (e) {
        poner(error, h("p", { class: "error", role: "alert" }, e.status ? e.message : e.message || "No se pudo guardar el registro."));
        enviar.disabled = false; enviar.textContent = "Registrar punto";
      }
    });
  }

  function pantallaCompleto() {
    liberar();
    limpiar(caja);
    poner(caja, cab("¡Rondín completo!"), h("progress", { class: "progreso", max: 1, value: 1 }),
      h("p", { class: "marcar-estado ok" }, "Registraste todos los puntos de este rondín."), h("button", { class: "btn primario grande", type: "button", onclick: cerrar }, "Listo"));
  }

  (async () => {
    try { await cargar(); await pantallaEscaneo(); }
    catch (e) {
      limpiar(caja);
      poner(caja, h("div", { class: "marcar-cab" }, h("span", { class: "marcar-paso" }, "Rondín"), h("button", { class: "btn-icono", type: "button", onclick: cerrar, "aria-label": "Cerrar" }, "✕"), h("h2", {}, "Rondín")),
        h("p", { class: "marcar-estado mal" }, e.message), h("button", { class: "btn secundario", type: "button", onclick: cerrar }, "Cerrar"));
    }
  })();
}
