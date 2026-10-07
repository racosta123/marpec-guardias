// Captura de ubicación para administración (formularios de Sitio y de Punto de rondín):
//  - leer latitud/longitud de un enlace de Google Maps o de coordenadas pegadas (TODO local, sin red);
//  - aviso de precisión baja del GPS;
//  - controles «Elegir en el mapa» y «Pegar enlace o coordenadas» (el mapa se carga solo al abrirlo: js/mapa.js).
import { h, toast } from "./ui.js";

export const HERMOSILLO = { lat: 29.0729, lng: -110.9559 };
export const PRECISION_BAJA_M = 100;

export function mensajePrecision(m) {
  return Number.isFinite(m) && m > PRECISION_BAJA_M ? `Precisión baja (±${Math.round(m)} m). Usa el celular al aire libre o elige en el mapa` : null;
}

const R = String.raw;
const NUM = R`-?\d{1,3}(?:\.\d+)?`;
const PAR = R`(${NUM})\s*,\s*(${NUM})`;
const valido = (la, lo) => Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
const redondear = (x) => Math.round(x * 1e6) / 1e6;
const salida = (la, lo) => (valido(la, lo) ? { lat: redondear(la), lng: redondear(lo) } : { error: "Las coordenadas están fuera de rango (latitud ±90, longitud ±180)." });

// Grados/minutos/segundos: 29°04'22.4"N 110°57'21.2"W (O/W = oeste, S = sur → negativos).
function dms(t) {
  const p = (x) => {
    const m = /(\d{1,3})\s*[°º]\s*(?:(\d{1,2})\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″”]|'')\s*)?([NSEWO])/i.exec(x);
    if (!m) return null;
    const v = Number(m[1]) + Number(m[2] || 0) / 60 + Number(m[3] || 0) / 3600;
    return /[SWO]/i.test(m[4]) ? -v : v;
  };
  const m = /^(.*?[NS])\W*(.*?[EWO])\W*$/i.exec(t) || /^(.*?[EWO])\W*(.*?[NS])\W*$/i.exec(t);
  if (!m) return null;
  const a = p(m[1]), b = p(m[2]);
  if (a === null || b === null) return null;
  return /[NS]$/i.test(m[1].trim()) ? [a, b] : [b, a];
}

// Devuelve { lat, lng } o { error }. Entiende: «29.0729, -110.9559», «29,0729 -110,9559», grados-minutos-segundos,
// geo:lat,lng y enlaces de Google Maps (…/@lat,lng,17z · …!3dLAT!4dLNG · ?q=lat,lng · ?ll=lat,lng) y de OpenStreetMap.
// Los enlaces cortos (maps.app.goo.gl) no se pueden leer sin consultar la red: se avisa cómo resolverlo.
export function parsearUbicacion(entrada) {
  let t = String(entrada ?? "").trim();
  if (!t) return { error: "Pega un enlace de Google Maps o las coordenadas." };
  try { t = decodeURIComponent(t.replace(/\+/g, " ")); } catch { /* texto con % literal: se usa tal cual */ }
  if (/(?:^|\/\/)(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/)/i.test(t)) {
    return { error: "Los enlaces cortos (maps.app.goo.gl) no se pueden leer sin red. Ábrelo en el navegador y copia el enlace largo de la barra de direcciones, o pega las coordenadas." };
  }
  let m;
  if ((m = new RegExp(R`!3d(${NUM})!4d(${NUM})`).exec(t))) return salida(Number(m[1]), Number(m[2]));                       // pin del lugar (Google)
  if ((m = new RegExp(R`[?&](?:q|ll|query|destination|daddr|center|sll)=\s*${PAR}`, "i").exec(t))) return salida(Number(m[1]), Number(m[2]));
  if ((m = new RegExp(R`@\s*${PAR}`).exec(t))) return salida(Number(m[1]), Number(m[2]));                                     // centro de la vista (Google)
  if ((m = new RegExp(R`mlat=(${NUM})&(?:amp;)?mlon=(${NUM})`, "i").exec(t))) return salida(Number(m[1]), Number(m[2]));      // OpenStreetMap
  if ((m = new RegExp(R`#map=\d+/(${NUM})/(${NUM})`).exec(t))) return salida(Number(m[1]), Number(m[2]));
  if ((m = new RegExp(R`^geo:${PAR}`, "i").exec(t))) return salida(Number(m[1]), Number(m[2]));
  if ((m = new RegExp(R`^\(?\s*(${NUM})\s*[,;\s]\s*(${NUM})\s*\)?$`).exec(t))) return salida(Number(m[1]), Number(m[2]));
  if ((m = /^\(?\s*(-?\d{1,3},\d+)\s*[;\s]\s*(-?\d{1,3},\d+)\s*\)?$/.exec(t))) return salida(Number(m[1].replace(",", ".")), Number(m[2].replace(",", ".")));
  const g = dms(t);
  if (g) return salida(g[0], g[1]);
  return { error: "No encontré coordenadas. Pega el enlace largo de Google Maps (con «@29.07,-110.95») o escribe «29.0729, -110.9559»." };
}

const numero = (el) => { const n = Number(String(el.value).trim().replace(",", ".")); return String(el.value).trim() !== "" && Number.isFinite(n) ? n : null; };

// Controles comunes de los dos formularios. `alElegir(lat, lng)` los llena (y borra la precisión de GPS).
export function controlesUbicacion({ lat, lng, radio, estado, alElegir }) {
  const poner = (la, lo, texto) => {
    alElegir(la, lo);
    estado.textContent = texto;
  };
  const btnMapa = h("button", { class: "btn secundario", type: "button" }, "🗺️ Elegir en el mapa");
  btnMapa.addEventListener("click", async () => {
    btnMapa.disabled = true;
    try {
      const { elegirEnMapa } = await import("./mapa.js"); // Leaflet y los mosaicos solo se cargan aquí
      const la = numero(lat), lo = numero(lng);
      const r = await elegirEnMapa({
        lat: la !== null && lo !== null && valido(la, lo) ? la : null, lng: lo,
        radioM: numero(radio) ?? 100, radioMin: Number(radio.min) || 5, radioMax: Number(radio.max) || 1000,
      });
      if (r) {
        poner(r.lat, r.lng, `Ubicación elegida en el mapa: ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}.`);
        if (r.radioM !== numero(radio)) radio.value = r.radioM;
      }
    } catch {
      toast("No se pudo cargar el mapa. Revisa tu conexión o pega las coordenadas.", "error");
    } finally {
      btnMapa.disabled = false;
    }
  });

  const entrada = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "https://www.google.com/maps/@29.07,-110.95,17z  ·  29.0729, -110.9559", "aria-describedby": "ayuda-enlace" });
  const usar = () => {
    const r = parsearUbicacion(entrada.value);
    if (r.error) { estado.textContent = r.error; return; }
    entrada.value = "";
    poner(r.lat, r.lng, `Ubicación tomada del texto pegado: ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)} (sin precisión de GPS).`);
  };
  entrada.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); usar(); } });
  entrada.addEventListener("paste", () => setTimeout(() => { if (entrada.value.trim()) usar(); }, 0));
  const btnUsar = h("button", { class: "btn chico secundario", type: "button", onclick: usar }, "Usar");
  const bloqueEnlace = h("label", { class: "campo" },
    h("span", { class: "campo-et" }, "Pegar enlace de Google Maps o coordenadas"),
    h("span", { class: "enlace-fila" }, entrada, btnUsar),
    h("small", { class: "ayuda", id: "ayuda-enlace" }, "Se lee en este dispositivo; no se consulta ningún servicio."));
  return { btnMapa, bloqueEnlace };
}
