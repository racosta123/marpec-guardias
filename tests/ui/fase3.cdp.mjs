// Prueba de la interfaz de la Fase 3 con Chrome real (cámara y GPS simulados por Chrome; sin dependencias).
// Uso: node tests/ui/fase3.cdp.mjs http://localhost:5182   (servidor: node tools/serve.mjs 5182 --fake)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("uso: node tests/ui/fase3.cdp.mjs <urlBase>");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9600 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "about:blank"], { stdio: "ignore" });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✖"} ${n}${extra ? "  → " + extra : ""}`); if (!ok) fallos++; };

try {
  let url = null;
  for (let i = 0; i < 50 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${puerto}/json`)).json()).find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch { /* arrancando */ }
    await espera(200);
  }
  const sock = new WebSocket(url);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const pend = new Map();
  const errores = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") errores.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cmd("Page.enable");
  await cmd("Runtime.enable");
  await cmd("Browser.grantPermissions", { permissions: ["geolocation", "videoCapture"], origin: new URL(base).origin });
  const ir = async (u, ms = 3500) => { await cmd("Page.navigate", { url: `${base}${u}` }); await espera(ms); };
  const texto = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);

  // ---------------- GUARDIA: estado, botón grande, notas del relevo, asistente ----------------
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 9 });
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `window.BarcodeDetector = class { constructor() {} async detect() { return [{ rawValue: "MPC1.siteA.1.AAAAAAAAAAAAAAAAAAAAAA" }]; } };` });
  await ir("/index.html?rol=guardia");
  const tarjeta = await texto("#contenido");
  check("guardia: muestra su turno, sitio y consignas", /Plaza Norte/.test(tarjeta) && /Rondín cada 2 horas/.test(tarjeta));
  check("guardia: botón grande «MARCAR ENTRADA» (ventana abierta)", /MARCAR ENTRADA/i.test(tarjeta));
  check("guardia: ve las notas de entrega del turno anterior", /Notas de entrega de Gema Guardia/i.test(tarjeta) && /Llaves en caseta/.test(tarjeta));

  await ev("document.querySelector('.btn.grande').click()");
  await espera(300);
  const intro = await texto(".marcar-caja");
  check("asistente: explica ubicación, QR y selfie antes de pedir permisos", /Ubicación/.test(intro) && /QR del puesto/.test(intro) && /Selfie/.test(intro) && /No se rastrea/.test(intro));
  await ev("[...document.querySelectorAll('.marcar-caja button')].find((b) => /Comenzar/i.test(b.textContent)).click()");
  await espera(1500);
  const gps = await texto(".marcar-caja");
  check("paso 1: GPS dentro del perímetro con precisión mostrada", /±9 m/.test(gps) && /Estás a \d+ m del puesto/.test(gps), gps.replace(/\n+/g, " ").slice(0, 120));
  await ev("[...document.querySelectorAll('.marcar-caja button')].find((b) => /Continuar/i.test(b.textContent) && !b.hidden).click()");
  await espera(2500); // QR (BarcodeDetector simulado) → pasa solo a la selfie
  const selfie = await texto(".marcar-caja");
  check("paso 2→3: el QR del puesto se reconoce y se abre la selfie en vivo", /Selfie en vivo/i.test(selfie));
  check("paso 3: cámara frontal en vivo y SIN selector de archivos", (await ev("!!document.querySelector('.marcar-video') && document.querySelectorAll('input[type=file]').length === 0")) === true);
  await espera(1500);
  await ev("[...document.querySelectorAll('.marcar-caja button')].find((b) => /Tomar selfie/i.test(b.textContent)).click()");
  await espera(1500);
  check("paso 4: vista previa de la selfie y resumen", (await ev("!!document.querySelector('.marcar-prev')")) === true && /QR del puesto escaneado/.test(await texto(".marcar-caja")));
  await ev("window.__llamadas.length = 0; [...document.querySelectorAll('.marcar-caja button')].find((b) => /Registrar entrada/i.test(b.textContent)).click()");
  await espera(1200);
  const envio = JSON.parse(await ev("JSON.stringify(window.__llamadas.find((l) => l.ruta === '/marcas/entrada') || null)"));
  check("envío: POST /marcas/entrada con GPS, QR y selfie", Boolean(envio) && envio.body.turnoId === "t5" && envio.body.qr.startsWith("MPC1.siteA.") && Math.abs(envio.body.lat - 29.0729) < 0.001 && envio.body.precisionM > 0);
  const foto = Buffer.from(envio.body.foto, "base64");
  check("selfie: JPEG real (FFD8FF…FFD9) de ≤ ~100 KB", foto[0] === 0xff && foto[1] === 0xd8 && foto[2] === 0xff && foto[foto.length - 2] === 0xff && foto[foto.length - 1] === 0xd9 && foto.length <= 100 * 1024, `${Math.round(foto.length / 1024)} KB`);
  check("se envía la hora del dispositivo solo como dato informativo", typeof envio.body.horaDispositivoMs === "number");
  check("al terminar el asistente se cierra", (await ev("!document.querySelector('.marcar-fondo')")) === true);

  // Fuera del perímetro: el asistente no deja continuar
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.09, longitude: -110.9559, accuracy: 9 });
  await ir("/index.html?rol=guardia");
  await ev("document.querySelector('.btn.grande').click()");
  await espera(300);
  await ev("[...document.querySelectorAll('.marcar-caja button')].find((b) => /Comenzar/i.test(b.textContent)).click()");
  await espera(1500);
  const lejos = await texto(".marcar-caja");
  check("fuera del perímetro: avisa y ofrece reintentar (sin continuar)", /fuera del perímetro/i.test(lejos) && (await ev("![...document.querySelectorAll('.marcar-caja button')].some((b) => /Continuar/i.test(b.textContent) && !b.hidden)")) === true, lejos.replace(/\n+/g, " ").slice(0, 160));
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 300 });
  await ev("[...document.querySelectorAll('.marcar-caja button')].find((b) => /Reintentar/i.test(b.textContent) && !b.hidden).click()");
  await espera(1500);
  check("precisión peor que el radio: se rechaza en pantalla", /peor que el radio/i.test(await texto(".marcar-caja")));

  // Sin conexión
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 9 });
  await ir("/index.html?rol=guardia");
  await ev("document.querySelector('.btn.grande').click()");
  await espera(300);
  await cmd("Network.enable");
  await cmd("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await ev("window.dispatchEvent(new Event('offline'))");
  await ev("Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })");
  await ev("[...document.querySelectorAll('.marcar-caja button')].find((b) => /Comenzar/i.test(b.textContent)).click()");
  await espera(500);
  check("sin conexión (Fase 6): el asistente ya NO se bloquea; avanza a la ubicación (el registro se guardará en la cola)", /Paso 1 de 4/i.test(await texto(".marcar-caja")));
  await cmd("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // ---------------- SUPERVISOR: panel de asistencia ----------------
  await ir("/index.html?rol=supervisor");
  const tabs = await ev("[...document.querySelectorAll('.tab-app')].map((b) => b.textContent).join(',')");
  check("supervisor: pestañas En vivo, Asistencia, Rondines, Incidencias, Visitantes, Bitácoras, Sin conexión, Alertas, Turnos y Mis sitios", tabs === "En vivo,Asistencia,Rondines,Incidencias,Visitantes,Bitácoras,Sin conexión,Alertas,Turnos,Mis sitios", tabs);
  await ev("document.querySelector('[data-clave=asistencia]').click()");
  await espera(800);
  const panel = await texto("#contenido");
  check("supervisor: alerta «Relevo no llegó» con botón de autorizar cierre", /Relevo no llegó/i.test(panel) && /Autorizar cierre sin relevo/i.test(panel));
  check("supervisor: horas extra por autorizar", /Horas extra por autorizar/i.test(panel) && /Autorizar/i.test(panel));
  check("supervisor: ve solo SU sitio (no «Bodega Sur»)", !/Bodega Sur/.test(panel));
  await ev("document.querySelector('.alerta-caja .btn.peligro').click()");
  await espera(300);
  await ev("document.querySelector('.modal textarea').value = 'El relevo avisó que no llegará.'; document.querySelector('.modal form').requestSubmit()");
  await espera(600);
  const aut = JSON.parse(await ev("JSON.stringify(window.__llamadas.find((l) => l.ruta === '/relevo/autorizar-cierre') || null)"));
  check("autorizar cierre: envía motivo", Boolean(aut) && /no llegará/.test(aut.body.motivo));
  await ev("document.querySelector('[data-clave=asistencia]').click()");
  await espera(900);
  await ev("[...document.querySelectorAll('button')].find((x) => x.textContent === 'Ajuste').click()");
  await espera(300);
  const formAjuste = await texto(".modal");
  check("ajuste: formulario con tipo, hora y motivo obligatorio (la marca original no se edita)", /Motivo/i.test(formAjuste) && /no se modifica/i.test(formAjuste) && (await ev("document.querySelector('.modal textarea').required")) === true);
  await ev("document.querySelector('.modal .btn-icono').click()");

  // ---------------- ADMIN: reportes, CSV y configuración ----------------
  await ir("/index.html?rol=admin");
  const tabsA = await ev("[...document.querySelectorAll('.tab-app')].map((b) => b.textContent).join(',')");
  check("admin: pestañas incluyen Asistencia, Reportes y Empresa", /Asistencia/.test(tabsA) && /Reportes/.test(tabsA) && /Empresa/.test(tabsA), tabsA);
  await ev("document.querySelector('[data-clave=reportes]').click()");
  await espera(600);
  await ev("document.querySelector('#contenido form').requestSubmit()");
  await espera(900);
  const rep = await texto("#contenido");
  check("reporte: resumen por guardia, acumulado semanal y exceso de límite", /Resumen por guardia/i.test(rep) && /Gael Guardia/i.test(rep) && /EXCEDE/i.test(rep), rep.replace(/\n+/g, " ").slice(0, 160));
  const csv = await ev(`(async () => { const m = await import('/js/vistas/reportes.js'); return m.aCsv([{ fecha: '2026-10-05', sitioNombre: '=HYPERLINK("x")', guardiaNombre: 'Gael, "G"', inicioMs: 1790000000000, finMs: 1790040000000, estado: 'cumplido', entradaMs: 1790000100000, salidaMs: null, retardo: true, retardoMin: 15, falta: false, minutosExtra: 0, ajustes: 0, relevoAlerta: false }]); })()`);
  check("CSV: neutraliza fórmulas (=…) y escapa comas/comillas, con BOM UTF-8", csv.startsWith("\ufeff") && /'=HYPERLINK/.test(csv) && /"Gael, ""G"""/.test(csv));
  await ev("document.querySelector('[data-clave=empresa]').click()");
  await espera(600);
  const emp = await texto("#contenido");
  check("empresa: ventana de entrada, tolerancia de relevo y límites de horas extra por año", /Ventana de entrada/.test(emp) && /Tolerancia de relevo/.test(emp) && /Límite legal de horas extra/.test(emp)
    && (await ev("document.querySelectorAll('.limite-fila').length")) === 2);

  check("sin excepciones de JavaScript durante toda la prueba", errores.length === 0, errores.slice(0, 2).join(" | "));
  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS DE INTERFAZ (FASE 3) PASARON");
  sock.close();
  process.exitCode = fallos ? 1 : 0;
} finally {
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
