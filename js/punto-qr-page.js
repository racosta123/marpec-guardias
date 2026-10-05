// Hoja imprimible de QR de puntos de control: un punto (?id=) o todos los del sitio (?sitio=).
// Requiere sesión de admin o del supervisor del sitio. Cada tarjeta lleva logo, sitio y nombre del punto.
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged,
} from "./vendor/firebase.js";
import { qrMatriz } from "./vendor/qr.js";
import { config } from "./config.js";
import { crearApi } from "./api.js";

const $ = (id) => document.getElementById(id);
const auth = initializeAuth(initializeApp(config.firebase), { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const api = crearApi(auth);
const NS = "http://www.w3.org/2000/svg";
const el = (tag, clase, texto) => { const n = document.createElement(tag); if (clase) n.className = clase; if (texto !== undefined) n.textContent = texto; return n; };

function dibujar(texto) {
  const { n, oscuro } = qrMatriz(texto);
  const q = 4;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n + 2 * q} ${n + 2 * q}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Código QR del punto de control");
  const fondo = document.createElementNS(NS, "rect");
  fondo.setAttribute("width", n + 2 * q); fondo.setAttribute("height", n + 2 * q); fondo.setAttribute("fill", "#ffffff");
  const trazo = document.createElementNS(NS, "path");
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (oscuro[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  trazo.setAttribute("d", d); trazo.setAttribute("fill", "#000000");
  svg.append(fondo, trazo);
  return svg;
}

function tarjeta(sitio, p) {
  const t = el("section", "punto-tarjeta");
  const logo = el("img", "punto-logo"); logo.src = "marpec-logo.png"; logo.alt = "MARPEC"; logo.width = 60; logo.height = 64;
  const cont = el("div", "punto-qr"); cont.append(dibujar(p.payload));
  t.append(logo, el("p", "punto-sitio", sitio.nombre), el("h2", "punto-nombre", `${p.orden != null ? p.orden + ". " : ""}${p.nombre}`),
    p.descripcion ? el("p", "punto-desc", p.descripcion) : el("span"), cont, el("p", "punto-pie", `Punto de control v${p.version} · Escanear solo con la app MARPEC Guardias`));
  return t;
}

onAuthStateChanged(auth, async (user) => {
  const p = new URLSearchParams(location.search);
  const id = p.get("id"), sitioId = p.get("sitio");
  if (!id && !sitioId) return ($("qr-estado").textContent = "Falta el identificador del punto o del sitio.");
  if (!user) return ($("qr-estado").textContent = "Inicia sesión en la aplicación como administrador o supervisor y vuelve a abrir esta página.");
  try {
    let sitio, puntos;
    if (sitioId) {
      const r = await api(`/puntos/qr-sitio?sitioId=${encodeURIComponent(sitioId)}`, { method: "GET" });
      sitio = r.sitio; puntos = r.puntos;
    } else {
      const r = await api(`/puntos/qr?id=${encodeURIComponent(id)}`, { method: "GET" });
      sitio = r.sitio; puntos = [{ ...r.punto, version: r.version, payload: r.payload }];
    }
    if (!puntos.length) return ($("qr-estado").textContent = "Este sitio no tiene puntos activos.");
    $("qr-estado").hidden = true;
    const lista = $("lista");
    for (const pt of puntos) lista.append(tarjeta(sitio, pt));
    $("qr-imprimir").hidden = false;
    $("qr-imprimir").addEventListener("click", () => window.print());
    document.title = `QR de puntos · ${sitio.nombre}`;
  } catch (e) {
    $("qr-estado").textContent = e.status === 403 || e.status === 404 ? "No tienes acceso a este sitio o no existe." : e.message;
  }
});
