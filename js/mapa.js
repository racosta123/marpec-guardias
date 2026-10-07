// Ventana «Elegir en el mapa» (solo administración). Se importa de forma perezosa: Leaflet (js/vendor/leaflet.js, BSD-2-Clause)
// y su CSS se descargan únicamente al abrir la ventana. Los mosaicos vienen del servidor estándar de OpenStreetMap
// (tile.openstreetmap.org): dependencia externa documentada en docs/SEGURIDAD.md; no se cachean en el service worker.
// No hay buscador de direcciones ni ningún geocodificador.
import { h, modal, toast } from "./ui.js";
import { HERMOSILLO, mensajePrecision } from "./ubicacion.js";

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATRIBUCION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';

let leaflet = null;
async function cargarLeaflet() {
  if (leaflet) return leaflet;
  const href = new URL("../css/vendor/leaflet.css", import.meta.url).href;
  const hoja = h("link", { rel: "stylesheet", href });
  const listo = new Promise((ok, err) => { hoja.onload = ok; hoja.onerror = () => err(new Error("css")); });
  document.head.append(hoja);
  const [L] = await Promise.all([import("./vendor/leaflet.js"), listo]);
  leaflet = L;
  return L;
}

// → Promise<{ lat, lng, radioM } | null>   (null = cancelado)
export async function elegirEnMapa({ lat, lng, radioM = 100, radioMin = 5, radioMax = 1000 }) {
  const L = await cargarLeaflet();
  return new Promise((resolve) => {
    const hayInicio = Number.isFinite(lat) && Number.isFinite(lng);
    let pos = hayInicio ? { lat, lng } : null;
    let radio = radioM;
    let respuesta = null;

    const lienzo = h("div", { class: "mapa-lienzo", role: "application", "aria-label": "Mapa. Toca para colocar el pin; arrástralo para ajustarlo." });
    const lectura = h("output", { class: "mapa-lectura", "aria-live": "polite" });
    const aviso = h("small", { class: "ayuda", role: "status" }, "Toca el mapa o arrastra el pin. Acerca con el zoom para mayor precisión.");
    const campoRadio = h("input", { type: "number", min: radioMin, max: radioMax, step: 1, value: radio, inputmode: "numeric" });
    const btnMi = h("button", { class: "btn chico secundario", type: "button" }, "📍 Mi ubicación");
    const btnOk = h("button", { class: "btn primario", type: "button", disabled: !pos }, "Aceptar");
    const btnNo = h("button", { class: "btn secundario", type: "button" }, "Cancelar");
    const cuerpo = h("div", { class: "modal-cuerpo mapa-cuerpo" },
      lienzo,
      h("div", { class: "mapa-barra" },
        h("label", { class: "campo mapa-radio" }, h("span", { class: "campo-et" }, `Radio (m, ${radioMin} a ${radioMax})`), campoRadio),
        btnMi),
      lectura, aviso,
      h("small", { class: "ayuda mapa-priv" }, "Las imágenes del mapa las sirve OpenStreetMap: su servidor recibe tu dirección IP y la zona que estás viendo."),
      h("div", { class: "acciones" }, btnNo, btnOk));

    const m = modal("Elegir en el mapa", cuerpo, {
      clase: "modal-mapa", escCapturado: true,
      alCerrar: () => { mapa.remove(); resolve(respuesta); },
    });

    const mapa = L.map(lienzo, { zoomControl: true, attributionControl: true, doubleClickZoom: false, worldCopyJump: true });
    mapa.attributionControl.setPrefix(false);
    let fallos = 0;
    const capa = L.tileLayer(TILES, { maxZoom: 19, attribution: ATRIBUCION, referrerPolicy: "origin", keepBuffer: 1, updateWhenIdle: true }).addTo(mapa);
    capa.on("tileerror", () => {
      if (++fallos === 3) aviso.textContent = "No se cargaron las imágenes del mapa (sin conexión o bloqueadas). Puedes cerrar y pegar un enlace o las coordenadas.";
    });

    const icono = L.divIcon({ className: "pin-mapa", html: "", iconSize: [30, 40], iconAnchor: [15, 40] });
    let pin = null, circulo = null;
    const refrescar = () => {
      lectura.textContent = pos ? `Latitud ${pos.lat.toFixed(6)} · Longitud ${pos.lng.toFixed(6)}` : "Aún no hay punto elegido.";
      btnOk.disabled = !pos;
      if (pos && circulo) { circulo.setLatLng([pos.lat, pos.lng]); circulo.setRadius(radio); }
    };
    const colocar = (la, lo) => {
      pos = { lat: la, lng: lo };
      if (!pin) {
        pin = L.marker([la, lo], { icon: icono, draggable: true, autoPan: true, keyboard: false, title: "Arrastra para ajustar" }).addTo(mapa);
        circulo = L.circle([la, lo], { radius: radio, color: "#1B2A55", weight: 2, fillColor: "#1B2A55", fillOpacity: 0.14, interactive: false }).addTo(mapa);
        const alArrastrar = () => { const p = pin.getLatLng().wrap(); pos = { lat: p.lat, lng: p.lng }; refrescar(); };
        pin.on("drag", alArrastrar);
        pin.on("dragend", alArrastrar);
      } else pin.setLatLng([la, lo]);
      refrescar();
    };
    if (pos) {
      mapa.setView([pos.lat, pos.lng], 17); // Leaflet exige vista inicial antes de agregar capas
      colocar(pos.lat, pos.lng);
      mapa.fitBounds(circulo.getBounds(), { padding: [24, 24], maxZoom: 18 });
    } else {
      mapa.setView([HERMOSILLO.lat, HERMOSILLO.lng], 12);
      refrescar();
    }
    mapa.on("click", (e) => { const p = e.latlng.wrap(); colocar(p.lat, p.lng); }); // wrap: al dar la vuelta al mundo la longitud sigue en ±180
    setTimeout(() => mapa.invalidateSize(), 0); // el contenedor ya está en el documento y con tamaño

    campoRadio.addEventListener("input", () => {
      const v = Number(campoRadio.value);
      if (Number.isFinite(v) && v >= radioMin && v <= radioMax) { radio = Math.round(v); if (circulo) circulo.setRadius(radio); }
    });
    btnMi.addEventListener("click", () => {
      if (!navigator.geolocation) { aviso.textContent = "Este dispositivo no ofrece GPS."; return; }
      btnMi.disabled = true;
      aviso.textContent = "Obteniendo tu ubicación…";
      navigator.geolocation.getCurrentPosition((p) => {
        mapa.setView([p.coords.latitude, p.coords.longitude], Math.max(mapa.getZoom(), 17));
        aviso.textContent = mensajePrecision(p.coords.accuracy) || `Mapa centrado en tu ubicación (±${Math.round(p.coords.accuracy)} m). Toca el mapa para colocar el pin.`;
        btnMi.disabled = false;
      }, (err) => {
        aviso.textContent = err.code === 1 ? "Permiso de ubicación denegado." : "No se pudo obtener tu ubicación.";
        btnMi.disabled = false;
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
    btnNo.addEventListener("click", () => m.cerrar());
    btnOk.addEventListener("click", () => {
      const v = Number(campoRadio.value);
      if (!Number.isFinite(v) || v < radioMin || v > radioMax) { toast(`El radio debe estar entre ${radioMin} y ${radioMax} metros.`, "error"); campoRadio.focus(); return; }
      respuesta = { lat: Math.round(pos.lat * 1e6) / 1e6, lng: Math.round(pos.lng * 1e6) / 1e6, radioM: Math.round(v) };
      m.cerrar();
    });
  });
}
