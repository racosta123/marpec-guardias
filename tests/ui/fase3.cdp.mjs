// Prueba de la interfaz de la Fase 3 con Chrome real (cámara y GPS simulados por Chrome; sin dependencias).
// Uso: node tests/ui/fase3.cdp.mjs http://localhost:5182   (servidor: node tools/serve.mjs 5182 --fake)
import { spawn, spawnSync } from "node:child_process";
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
  // Celular lento: LENTO=6 limita la CPU a 1/6 (LENTO=1, por omisión, sin límite). La prueba no debe depender de la velocidad.
  const lento = Number(process.env.LENTO || 1);
  if (lento > 1) await cmd("Emulation.setCPUThrottlingRate", { rate: lento });
  // Reloj del navegador fijado alrededor de las 12:00 (Hermosillo) de HOY: las pruebas no dependen de la hora del día
  // (los datos simulados son relativos a «ahora» y a la fecha local; cerca de la medianoche cambiaban de día).
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const R = Date.now.bind(Date); const h = new Date(R() - 7 * 3600e3); const off = Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate(), 12, 0) + 7 * 3600e3 - R(); const D = Date; globalThis.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(R() + off); } static now() { return R() + off; } }; })();` });
  await cmd("Browser.grantPermissions", { permissions: ["geolocation", "videoCapture"], origin: new URL(base).origin });
  const ir = async (u, ms = 3500) => {
    await cmd("Page.navigate", { url: `${base}${u}` });
    // el primer arranque de Chrome puede tardar varios segundos: se espera a que la app salga de «Cargando…»
    const fin = Date.now() + 20000;
    while (Date.now() < fin) { await espera(250); if (await ev("(() => { const c = document.getElementById('cargando'); return Boolean(c) && c.hidden; })()")) break; }
    await hasta("!/Cargando tu turno|Conectando en vivo|Cargando/.test((document.getElementById('contenido') || {}).innerText || '')", 30000); // la sección termina de cargar (no depende de la velocidad)
    await espera(ms);
  };
  const texto = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
  // Esperas por CONDICIÓN (no por tiempo fijo): la prueba no debe depender de lo rápido que arranque la cámara o la CPU.
  const hasta = async (expr, ms = 30000) => { const fin = Date.now() + ms; do { if (await ev(expr)) return true; await espera(120); } while (Date.now() < fin); return false; };
  const conTexto = async (sel, re, ms = 30000) => { const fin = Date.now() + ms; let t = ""; do { t = await texto(sel); if (re.test(t)) return t; await espera(120); } while (Date.now() < fin); return t; };
  const clicBtn = async (re, sel = ".marcar-caja button", ms = 30000) => {
    const q = `[...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent) && !x.hidden && !x.disabled)`;
    await hasta(`!!(${q})`, ms);
    return ev(`(() => { const b = ${q}; if (b) b.click(); return !!b; })()`);
  };
  const videoListo = (sel = ".marcar-video") => hasta(`(() => { const v = document.querySelector(${JSON.stringify(sel)}); return !!v && v.readyState >= 2 && v.videoWidth > 0; })()`);

  // ---------------- GUARDIA: estado, botón grande, notas del relevo, asistente ----------------
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 9 });
  // Cámara lenta: CAMARA_MS=3000 retrasa getUserMedia (un celular que tarda en abrir la cámara). Además registra cada stream abierto.
  const camMs = Number(process.env.CAMARA_MS || 0);
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const g = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.__streams = []; navigator.mediaDevices.getUserMedia = async (c) => { await new Promise((r) => setTimeout(r, window.__camMs ?? ${camMs})); const s = await g(c); window.__streams.push(s); return s; }; })();` });
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `window.BarcodeDetector = class { constructor() {} async detect() { return [{ rawValue: "MPC1.siteA.1.AAAAAAAAAAAAAAAAAAAAAA" }]; } };` });
  await ir("/index.html?rol=guardia");
  const tarjeta = await conTexto("#contenido", /Llaves en caseta/, 30000); // el inicio se arma por partes (turno, sitio, notas del relevo): se espera a que esté completo
  check("guardia: muestra su turno, sitio y consignas", /Plaza Norte/.test(tarjeta) && /Rondín cada 2 horas/.test(tarjeta));
  check("guardia: botón grande «MARCAR ENTRADA» (ventana abierta)", /MARCAR ENTRADA/i.test(tarjeta));
  const chicos = await ev("[...document.querySelectorAll('#vista-inicio button, #vista-inicio a.btn, #btn-panico')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 47.5; }).map((b) => (b.textContent || b.id).trim().slice(0, 20) + ' ' + Math.round(b.getBoundingClientRect().height)).join(' | ')");
  check("guardia: todos los botones del inicio miden al menos 48 px de alto", chicos === "", chicos);
  check("guardia: ve las notas de entrega del turno anterior", /Notas de entrega de Gema Guardia/i.test(tarjeta) && /Llaves en caseta/.test(tarjeta));

  await hasta("!!document.querySelector('.btn.grande')");
  await ev("document.querySelector('.btn.grande').click()");
  const intro = await conTexto(".marcar-caja", /No se rastrea/);
  check("asistente: explica ubicación, QR y selfie antes de pedir permisos", /Ubicación/.test(intro) && /QR del puesto/.test(intro) && /Selfie/.test(intro) && /No se rastrea/.test(intro));
  await clicBtn(/Comenzar/i);
  const gps = await conTexto(".marcar-caja", /Estás a \d+ m del puesto|fuera del perímetro/);
  check("paso 1: GPS dentro del perímetro con precisión mostrada", /±9 m/.test(gps) && /Estás a \d+ m del puesto/.test(gps), gps.replace(/\n+/g, " ").slice(0, 120));
  await clicBtn(/Continuar/i);
  const selfie = await conTexto(".marcar-caja", /Selfie en vivo/i); // QR (BarcodeDetector simulado) → pasa solo a la selfie, tarde lo que tarde la cámara
  check("paso 2→3: el QR del puesto se reconoce y se abre la selfie en vivo", /Selfie en vivo/i.test(selfie));
  check("paso 3: cámara frontal en vivo y SIN selector de archivos", (await videoListo()) && (await ev("document.querySelectorAll('input[type=file]').length === 0")) === true);
  await clicBtn(/Tomar selfie/i);
  await hasta("!!document.querySelector('.marcar-prev')");
  check("paso 4: vista previa de la selfie y resumen", (await ev("!!document.querySelector('.marcar-prev')")) === true && /QR del puesto escaneado/.test(await texto(".marcar-caja")));
  await ev("window.__llamadas.length = 0");
  await clicBtn(/Registrar entrada/i);
  await hasta("window.__llamadas.some((l) => l.ruta === '/marcas/entrada')");
  const envio = JSON.parse(await ev("JSON.stringify(window.__llamadas.find((l) => l.ruta === '/marcas/entrada') || null)"));
  check("envío: POST /marcas/entrada con GPS, QR y selfie", Boolean(envio) && envio.body.turnoId === "t5" && envio.body.qr.startsWith("MPC1.siteA.") && Math.abs(envio.body.lat - 29.0729) < 0.001 && envio.body.precisionM > 0);
  const foto = Buffer.from(envio.body.foto, "base64");
  check("selfie: JPEG real (FFD8FF…FFD9) de ≤ ~100 KB", foto[0] === 0xff && foto[1] === 0xd8 && foto[2] === 0xff && foto[foto.length - 2] === 0xff && foto[foto.length - 1] === 0xd9 && foto.length <= 100 * 1024, `${Math.round(foto.length / 1024)} KB`);
  check("se envía la hora del dispositivo solo como dato informativo", typeof envio.body.horaDispositivoMs === "number");
  check("al terminar el asistente se cierra", (await hasta("!document.querySelector('.marcar-fondo')")) === true);
  check("al terminar NO queda ninguna cámara abierta (todos los streams detenidos)", (await hasta("window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))")) === true);

  // Fuera del perímetro: el asistente no deja continuar
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.09, longitude: -110.9559, accuracy: 9 });
  await ir("/index.html?rol=guardia");
  await hasta("!!document.querySelector('.btn.grande')");
  await ev("document.querySelector('.btn.grande').click()");
  await clicBtn(/Comenzar/i);
  const lejos = await conTexto(".marcar-caja", /fuera del perímetro|Reintentar/i);
  check("fuera del perímetro: avisa y ofrece reintentar (sin continuar)", /fuera del perímetro/i.test(lejos) && (await ev("![...document.querySelectorAll('.marcar-caja button')].some((b) => /Continuar/i.test(b.textContent) && !b.hidden)")) === true, lejos.replace(/\n+/g, " ").slice(0, 160));
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 300 });
  await clicBtn(/Reintentar/i);
  check("precisión peor que el radio: se rechaza en pantalla", /peor que el radio/i.test(await conTexto(".marcar-caja", /peor que el radio/i)));

  // Cámara lenta + cancelar: una cámara que termina de abrir DESPUÉS de cancelar no debe quedar encendida
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 9 });
  await ir("/index.html?rol=guardia");
  await ev("window.__camMs = 1500; window.__streams.length = 0");
  await hasta("!!document.querySelector('.btn.grande')");
  await ev("document.querySelector('.btn.grande').click()");
  await clicBtn(/Comenzar/i);
  await conTexto(".marcar-caja", /Estás a \d+ m del puesto/);
  await clicBtn(/Continuar/i);
  await ev("document.querySelector('.marcar-cab .btn-icono').click()"); // cancelar con la cámara aún abriéndose
  await hasta("window.__streams.length >= 1", 30000); // la cámara termina de abrir DESPUÉS de cancelar (tarde lo que tarde)
  check("cancelar con la cámara aún abriéndose (celular lento): ninguna cámara queda encendida", (await hasta("window.__streams.length >= 1 && window.__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))", 10000)) === true, await ev("JSON.stringify(window.__streams.map((s) => s.getTracks().map((t) => t.readyState)))"));

  // Sin conexión
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 9 });
  await ir("/index.html?rol=guardia");
  await hasta("!!document.querySelector('.btn.grande')");
  await ev("document.querySelector('.btn.grande').click()");
  await hasta("!!document.querySelector('.marcar-caja')");
  await cmd("Network.enable");
  await cmd("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await ev("window.dispatchEvent(new Event('offline'))");
  await ev("Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })");
  await clicBtn(/Comenzar/i);
  check("sin conexión (Fase 6): el asistente ya NO se bloquea; avanza a la ubicación (el registro se guardará en la cola)", /Paso 1 de 4/i.test(await conTexto(".marcar-caja", /Paso 1 de 4/i)));
  await cmd("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // ---------------- SUPERVISOR: panel de asistencia ----------------
  await ir("/index.html?rol=supervisor");
  const tabs = await ev("[...document.querySelectorAll('.tab-app')].map((b) => b.textContent).join(',')");
  check("supervisor: pestañas En vivo, Asistencia, Rondines, Incidencias, Visitantes, Bitácoras, Sin conexión, Alertas, Turnos y Mis sitios", tabs === "En vivo,Asistencia,Rondines,Incidencias,Visitantes,Bitácoras,Sin conexión,Alertas,Turnos,Mis sitios", tabs);
  await hasta("!!document.querySelector('[data-clave=asistencia]')");
  await ev("document.querySelector('[data-clave=asistencia]').click()");
  const panel = await conTexto("#contenido", /Autorizar cierre sin relevo/i);
  check("supervisor: alerta «Relevo no llegó» con botón de autorizar cierre", /Relevo no llegó/i.test(panel) && /Autorizar cierre sin relevo/i.test(panel));
  check("supervisor: horas extra por autorizar", /Horas extra por autorizar/i.test(panel) && /Autorizar/i.test(panel));
  check("supervisor: ve solo SU sitio (no «Bodega Sur»)", !/Bodega Sur/.test(panel));
  await ev("document.querySelector('.alerta-caja .btn.peligro').click()");
  await hasta("!!document.querySelector('.modal textarea')");
  await ev("document.querySelector('.modal textarea').value = 'El relevo avisó que no llegará.'; document.querySelector('.modal form').requestSubmit()");
  await hasta("window.__llamadas.some((l) => l.ruta === '/relevo/autorizar-cierre')");
  const aut = JSON.parse(await ev("JSON.stringify(window.__llamadas.find((l) => l.ruta === '/relevo/autorizar-cierre') || null)"));
  check("autorizar cierre: envía motivo", Boolean(aut) && /no llegará/.test(aut.body.motivo));
  await ev("document.querySelector('[data-clave=asistencia]').click()");
  await hasta("[...document.querySelectorAll('button')].some((x) => x.textContent === 'Ajuste')");
  await ev("[...document.querySelectorAll('button')].find((x) => x.textContent === 'Ajuste').click()");
  const formAjuste = await conTexto(".modal", /Motivo/i);
  check("ajuste: formulario con tipo, hora y motivo obligatorio (la marca original no se edita)", /Motivo/i.test(formAjuste) && /no se modifica/i.test(formAjuste) && (await ev("document.querySelector('.modal textarea').required")) === true);
  await ev("document.querySelector('.modal .btn-icono').click()");

  // ---------------- ADMIN: reportes, CSV y configuración ----------------
  await ir("/index.html?rol=admin");
  const tabsA = await ev("[...document.querySelectorAll('.tab-app')].map((b) => b.textContent).join(',')");
  check("admin: pestañas incluyen Asistencia, Reportes y Empresa", /Asistencia/.test(tabsA) && /Reportes/.test(tabsA) && /Empresa/.test(tabsA), tabsA);
  await hasta("!!document.querySelector('[data-clave=reportes]')");
  await ev("document.querySelector('[data-clave=reportes]').click()");
  await hasta("!!document.querySelector('#contenido form')");
  await ev("document.querySelector('#contenido form').requestSubmit()");
  const rep = await conTexto("#contenido", /Resumen por guardia/i);
  check("reporte: resumen por guardia, acumulado semanal y exceso de límite", /Resumen por guardia/i.test(rep) && /Gael Guardia/i.test(rep) && /EXCEDE/i.test(rep), rep.replace(/\n+/g, " ").slice(0, 160));
  const csv = await ev(`(async () => { const m = await import('/js/vistas/reportes.js'); return m.aCsv([{ fecha: '2026-10-05', sitioNombre: '=HYPERLINK("x")', guardiaNombre: 'Gael, "G"', inicioMs: 1790000000000, finMs: 1790040000000, estado: 'cumplido', entradaMs: 1790000100000, salidaMs: null, retardo: true, retardoMin: 15, falta: false, minutosExtra: 0, ajustes: 0, relevoAlerta: false }]); })()`);
  check("CSV: neutraliza fórmulas (=…) y escapa comas/comillas, con BOM UTF-8", csv.startsWith("\ufeff") && /'=HYPERLINK/.test(csv) && /"Gael, ""G"""/.test(csv));
  await ev("document.querySelector('[data-clave=empresa]').click()");
  const emp = await conTexto("#contenido", /Límite legal de horas extra/);
  check("empresa: ventana de entrada, tolerancia de relevo y límites de horas extra por año", /Ventana de entrada/.test(emp) && /Tolerancia de relevo/.test(emp) && /Límite legal de horas extra/.test(emp)
    && (await ev("document.querySelectorAll('.limite-fila').length")) === 2);

  check("sin excepciones de JavaScript durante toda la prueba", errores.length === 0, errores.slice(0, 2).join(" | "));
  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS DE INTERFAZ (FASE 3) PASARON");
  sock.close();
  process.exitCode = fallos ? 1 : 0;
} finally {
  try { spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ya terminó */ } // mata también los procesos hijos de Chrome
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
