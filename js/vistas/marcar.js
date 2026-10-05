// Asistente para marcar ENTRADA o SALIDA: 1) ubicación, 2) QR del puesto, 3) selfie en vivo, 4) envío.
// El Worker repite y decide todas las verificaciones; aquí solo se guía al guardia.
import {
  abrirCamara, capturarSelfie, detener, distanciaM, escanearQr, hayConexion, mostrarEnVideo, pedirUbicacion,
} from "../camara.js";
import { campo, h, limpiar, poner, toast } from "../ui.js";

const SIN_CONEXION = "Sin conexión, intenta de nuevo.";

// turno: { id, sitioId, sitioNombre }, sitio: { lat, lng, radioM } | null
export function abrirMarcado({ tipo, turno, sitio, api, alTerminar }) {
  const etiqueta = tipo === "entrada" ? "entrada" : "salida";
  const estado = { gps: null, qr: null, foto: null, notas: "" };
  let stream = null;
  let detenerQr = null;

  const fondo = h("div", { class: "marcar-fondo", role: "dialog", "aria-modal": "true", "aria-label": `Marcar ${etiqueta}` });
  const caja = h("div", { class: "marcar-caja" });
  fondo.append(caja);
  document.body.append(fondo);

  function liberar() {
    if (detenerQr) { detenerQr(); detenerQr = null; }
    if (stream) { detener(stream); stream = null; }
  }
  function cerrar() {
    liberar();
    if (estado.foto?.url) URL.revokeObjectURL(estado.foto.url);
    fondo.remove();
  }

  const cabecera = (paso, titulo) => h("div", { class: "marcar-cab" },
    h("span", { class: "marcar-paso" }, paso ? `Paso ${paso} de 4` : "Antes de empezar"),
    h("button", { class: "btn-icono", type: "button", "aria-label": "Cancelar", onclick: cerrar }, "✕"),
    h("h2", {}, titulo));
  const mostrar = (...nodos) => { liberar(); limpiar(caja); poner(caja, ...nodos); };
  const mensajeError = (msg) => h("p", { class: "error", role: "alert" }, msg);

  // ---------- 0. introducción ----------
  function intro() {
    const notas = tipo === "salida" ? h("textarea", { rows: 4, maxlength: 1000, placeholder: "Novedades, pendientes, llaves, equipo, avisos para quien te releva…" }) : null;
    mostrar(
      cabecera(0, `Marcar ${etiqueta}`),
      h("p", {}, h("b", {}, turno.sitioNombre)),
      h("ul", { class: "marcar-lista" },
        h("li", {}, h("b", {}, "Ubicación: "), "se pide solo ahora, para comprobar que estás en el puesto. No se rastrea tu ubicación."),
        h("li", {}, h("b", {}, "QR del puesto: "), "escanéalo con la cámara."),
        h("li", {}, h("b", {}, "Selfie: "), "con la cámara frontal en vivo. Se guarda en almacenamiento privado y solo la ven tu supervisor y la administración.")),
      notas ? campo("Notas de entrega para tu relevo (opcional)", notas, "Las verá quien te releve.") : null,
      h("button", { class: "btn primario", type: "button", onclick: () => { if (!hayConexion()) return toast(SIN_CONEXION, "error"); estado.notas = notas ? notas.value : ""; pasoGps(); } }, "Comenzar"));
  }

  // ---------- 1. GPS ----------
  async function pasoGps() {
    const estadoTxt = h("p", { role: "status", class: "marcar-estado" }, "Buscando tu ubicación…");
    const reintentar = h("button", { class: "btn secundario", type: "button", hidden: true, onclick: pasoGps }, "Reintentar");
    const seguir = h("button", { class: "btn primario", type: "button", hidden: true, onclick: pasoQr }, "Continuar");
    mostrar(cabecera(1, "Ubicación"), estadoTxt, reintentar, seguir);
    try {
      const g = await pedirUbicacion();
      estado.gps = g;
      const radio = sitio?.radioM ?? 100;
      const dist = sitio?.lat != null ? distanciaM(g.lat, g.lng, sitio.lat, sitio.lng) : null;
      const lineas = [`Precisión del GPS: ±${Math.round(g.precisionM)} m.`];
      let bien = true;
      if (g.precisionM > radio) { bien = false; lineas.push(`La precisión es peor que el radio del puesto (${radio} m). Sal a cielo abierto y reintenta.`); }
      if (dist !== null) {
        lineas.push(`Estás a ${Math.round(dist)} m del puesto (límite ${radio} m).`);
        if (dist > radio) { bien = false; lineas.push("Estás fuera del perímetro del puesto."); }
      }
      estadoTxt.textContent = lineas.join(" ");
      estadoTxt.className = `marcar-estado ${bien ? "ok" : "mal"}`;
      (bien ? seguir : reintentar).hidden = false;
      if (!bien) reintentar.hidden = false;
    } catch (e) {
      estadoTxt.textContent = e.message;
      estadoTxt.className = "marcar-estado mal";
      reintentar.hidden = false;
    }
  }

  // ---------- 2. QR ----------
  async function pasoQr() {
    const video = h("video", { class: "marcar-video", autoplay: true, playsinline: true, muted: true });
    const aviso = h("p", { role: "status", class: "marcar-estado" }, "Apunta la cámara al código QR del puesto.");
    mostrar(cabecera(2, "Escanea el QR del puesto"), video, aviso);
    try {
      stream = await abrirCamara("environment");
      await mostrarEnVideo(video, stream);
      detenerQr = escanearQr(video, (texto) => {
        if (!/^MPC1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/.test(texto)) { aviso.textContent = "Ese código no es de un puesto MARPEC."; aviso.className = "marcar-estado mal"; return; }
        const sitioQr = texto.split(".")[1];
        if (sitioQr !== turno.sitioId) { aviso.textContent = "Ese QR es de otro puesto. Escanea el de tu puesto."; aviso.className = "marcar-estado mal"; return; }
        estado.qr = texto;
        pasoSelfie();
      });
    } catch (e) {
      aviso.textContent = e.message;
      aviso.className = "marcar-estado mal";
      poner(caja, h("button", { class: "btn secundario", type: "button", onclick: pasoQr }, "Reintentar"));
    }
  }

  // ---------- 3. selfie ----------
  async function pasoSelfie() {
    const video = h("video", { class: "marcar-video espejo", autoplay: true, playsinline: true, muted: true });
    const aviso = h("p", { role: "status", class: "marcar-estado" }, "Mírate a la cámara frontal y toma tu selfie.");
    const tomar = h("button", { class: "btn primario", type: "button" }, "📸 Tomar selfie");
    mostrar(cabecera(3, "Selfie en vivo"), video, aviso, tomar);
    try {
      stream = await abrirCamara("user");
      await mostrarEnVideo(video, stream);
    } catch (e) {
      aviso.textContent = e.message;
      aviso.className = "marcar-estado mal";
      poner(caja, h("button", { class: "btn secundario", type: "button", onclick: pasoSelfie }, "Reintentar"));
      return;
    }
    tomar.addEventListener("click", async () => {
      tomar.disabled = true;
      try {
        estado.foto = await capturarSelfie(video);
        pasoEnviar();
      } catch (e) {
        aviso.textContent = e.message;
        aviso.className = "marcar-estado mal";
        tomar.disabled = false;
      }
    });
  }

  // ---------- 4. enviar ----------
  function pasoEnviar() {
    const boton = h("button", { class: "btn primario grande", type: "button" }, `Registrar ${etiqueta}`);
    const error = h("div", {});
    mostrar(
      cabecera(4, "Confirma y registra"),
      h("img", { class: "marcar-prev espejo", src: estado.foto.url, alt: "Tu selfie" }),
      h("ul", { class: "marcar-lista" },
        h("li", {}, `📍 Ubicación capturada (±${Math.round(estado.gps.precisionM)} m)`),
        h("li", {}, "🔳 QR del puesto escaneado"),
        h("li", {}, `📸 Selfie lista (${Math.round(estado.foto.blob.size / 1024)} KB)`)),
      h("button", { class: "btn secundario", type: "button", onclick: pasoSelfie }, "Repetir selfie"),
      boton, error);
    boton.addEventListener("click", async () => {
      limpiar(error);
      if (!hayConexion()) { poner(error, mensajeError(SIN_CONEXION)); return; }
      boton.disabled = true;
      boton.textContent = "Registrando…";
      try {
        const r = await api(`/marcas/${tipo}`, { body: {
          turnoId: turno.id, lat: estado.gps.lat, lng: estado.gps.lng, precisionM: estado.gps.precisionM, qr: estado.qr,
          foto: estado.foto.base64, horaDispositivoMs: Date.now(), ...(tipo === "salida" ? { notasEntrega: estado.notas } : {}),
        } });
        cerrar();
        toast(tipo === "entrada" ? (r.retardo ? `Entrada registrada con retardo (${r.retardoMin} min).` : "Entrada registrada.") : "Salida registrada. ¡Buen descanso!");
        alTerminar();
      } catch (e) {
        poner(error, mensajeError(e.status ? e.message : SIN_CONEXION));
        boton.disabled = false;
        boton.textContent = `Registrar ${etiqueta}`;
      }
    });
  }

  intro();
}
