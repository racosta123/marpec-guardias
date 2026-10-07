// Prueba del piloto de la ronda 2 del rediseño (Asistencia e Incidencias) con Chrome real por CDP, contra Firebase y Worker simulados
// (tools/serve.mjs --fake, datos de ejemplo ?demo=ronda2). Verifica indicadores, tarjeta de filtros, tablas, tiras de color, etiquetas,
// estado vacío compacto, que se conservan botones y acciones, y que no hay desbordes a 1440, 768 y 360 px. Guarda las capturas del piloto.
// Uso: node tests/ui/ronda2.cdp.mjs http://localhost:5182
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("uso: node tests/ui/ronda2.cdp.mjs <urlBase>");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9700 + Math.floor(Math.random() * 90);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const check = (n, ok, extra = "") => { console.log(`${ok ? "✔" : "✖"} ${n}${extra ? "  → " + extra : ""}`); if (!ok) fallos++; };
const PC = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const TAB = { width: 768, height: 1024, deviceScaleFactor: 1, mobile: false };
const CEL = { width: 360, height: 780, deviceScaleFactor: 2, mobile: true };

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
  // Si Chrome no responde en 40 s (equipo con poca memoria) la orden se da por fallida en vez de colgar la prueba
  const cmd = (method, params = {}) => new Promise((res) => {
    const id = ++n;
    const t = setTimeout(() => { pend.delete(id); console.log(`  (sin respuesta de Chrome a ${method})`); res({ error: "tiempo agotado" }); }, 40000);
    pend.set(id, (m) => { clearTimeout(t); res(m); });
    sock.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cmd("Page.enable"); await cmd("Runtime.enable");
  const hasta = async (expr, ms = 15000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (await ev(expr)) return true; await espera(150); } return false; };
  const vista = (v) => cmd("Emulation.setDeviceMetricsOverride", { ...v, screenWidth: v.width, screenHeight: v.height });
  const ir = async (v, clave) => {
    await vista(v);
    await cmd("Page.navigate", { url: `${base}/index.html?rol=admin&demo=ronda2` });
    const fin = Date.now() + 25000;
    while (Date.now() < fin) { await espera(250); if (await ev("(() => { const c = document.getElementById('cargando'); return Boolean(c) && c.hidden; })()")) break; }
    await espera(600);
    if (v.mobile) await ev("document.getElementById('btn-menu').click()");
    await ev(`document.querySelector('[data-clave=${clave}]').click()`);
    await hasta("!/Cargando/.test((document.getElementById('contenido') || {}).innerText || '') && document.querySelectorAll('#contenido .ind').length > 0");
    await espera(500);
  };
  const texto = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
  const cuenta = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const valores = () => ev("[...document.querySelectorAll('#contenido .ind')].map((i) => i.querySelector('.n').innerText + ' ' + i.querySelector('.t').innerText).join(' | ')");
  const sinDesborde = async (v) => { const r = await ev("({ sw: document.documentElement.scrollWidth, iw: innerWidth })"); return r.sw <= r.iw + 1 ? true : JSON.stringify(r); };
  const out = ".tools/capturas-rediseno";
  mkdirSync(out, { recursive: true });
  const foto = async (nombre, alto) => {
    const h = alto || (await ev("Math.ceil(document.querySelector('#contenido').getBoundingClientRect().bottom + scrollY + 20)"));
    const ancho = await ev("innerWidth");
    const r = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: ancho, height: Math.max(200, Math.min(Number(h) || 900, 2600)), scale: 1 } });
    if (!r.result) { console.log(`  (captura ${nombre} no disponible: ${JSON.stringify(r.error)})`); return; }
    writeFileSync(`${out}/${nombre}.png`, Buffer.from(r.result.data, "base64"));
  };
  const color = (sel, prop = "backgroundColor") => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)}))[${JSON.stringify(prop)}]`);

  // =================================================================== ASISTENCIA · escritorio
  await ir(PC, "asistencia");
  check("asistencia: encabezado con título, subtítulo del día y botón «Actualizar»", /Asistencia/.test(await texto(".pag-cab h2")) && /6 turno\(s\) con guardia · 1 retardo\(s\) · 1 falta\(s\)/.test(await texto(".pag-sub")) && /Actualizar/.test(await texto(".pag-cab")));
  const kv = await valores();
  check("escritorio: en Asistencia los botones de acción (Selfie entrada, Selfie salida, Ajuste) van en una sola línea", await ev("[...document.querySelectorAll('#contenido .fila .c-acc')].every((a) => { const t = [...a.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top)); return t.every((x) => Math.abs(x - t[0]) <= 1); })"));
  check("asistencia: 4 indicadores (azul, verde, ámbar, rojo) con los conteos del día", (await cuenta("#contenido .ind")) === 4 && /6 Turnos con guardia \| 2 En turno ahora \| 1 Retardos \| 1 Faltas/.test(kv), kv);
  const chip = await ev("(() => { const r = document.querySelector('#contenido .ind .chip').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()");
  check("indicadores: ícono en chip de 44 px", chip[0] === 44 && chip[1] === 44, String(chip));
  const fondos = await ev("[...document.querySelectorAll('#contenido .ind')].map((i) => getComputedStyle(i).backgroundColor).join(';')");
  check("indicadores: fondos suaves azul claro, verde claro, ámbar claro y rojo claro", fondos === "rgb(219, 234, 254);rgb(220, 252, 231);rgb(254, 243, 199);rgb(254, 226, 226)", fondos);
  check("tarjeta de filtros: Día y Sitio con etiqueta visible, «Limpiar», sobre tarjeta blanca con borde", /Día/.test(await texto(".fcard")) && /Sitio/.test(await texto(".fcard")) && /Limpiar/.test(await texto(".fcard")) && (await color(".fcard")) === "rgb(255, 255, 255)" && (await color(".fcard", "borderTopColor")) === "rgb(226, 232, 240)");
  const fecha = await ev("(() => { const i = document.querySelector('.fcard input[type=date]'); const r = i.getBoundingClientRect(); return { w: Math.round(r.width), cortado: i.scrollWidth > i.clientWidth + 1 }; })()");
  check("campo de fecha de escritorio: completo, sin cortarse", fecha.w >= 170 && !fecha.cortado, JSON.stringify(fecha));
  check("tabla: una tarjeta por sitio (2) y 6 filas con avatar de iniciales", (await cuenta("#contenido .tcard2")) === 2 && (await cuenta("#contenido .fila")) === 6 && (await ev("[...document.querySelectorAll('#contenido .fila .av')].map((a) => a.textContent).join(',')")) === "GG,LO,ID,GG,RM,MS");
  check("tira de color por estado: ok, ámbar (retardo), azul, rojo (falta)", (await ev("[...document.querySelectorAll('#contenido .fila')].map((f) => f.dataset.tira).join(',')")) === "ok,ambar,info,mal,ok,info");
  const tira = await ev("[...document.querySelectorAll('#contenido .fila')].map((f) => getComputedStyle(f).borderLeftColor).join(';')");
  check("la tira se pinta con el color del estado", tira.startsWith("rgb(22, 163, 74);rgb(245, 158, 11);rgb(30, 110, 255);rgb(220, 38, 38)"), tira);
  const et = await texto("#contenido");
  check("etiquetas de estado conservadas (Cumplido, En turno, FALTA, Programado, Retardo 18 min)", /Cumplido/i.test(et) && /En turno/i.test(et) && /FALTA/.test(et) && /Programado/i.test(et) && /Retardo 18 min/i.test(et));
  check("se conservan Entrada/Salida, notas de entrega y distancia al sitio", /06:5\d|\d\d:\d\d/.test(et) && /Notas de entrega: Portón 2 con falla/.test(et) && /Entrada a 12 m del sitio/.test(et));
  check("acciones conservadas: «Ajuste» en cada fila y selfies de entrada/salida", (await ev("[...document.querySelectorAll('#contenido .fila button')].filter((b) => b.textContent === 'Ajuste').length")) === 6 && (await ev("[...document.querySelectorAll('#contenido .fila button')].some((b) => b.textContent === 'Selfie entrada')")) === true);
  check("sin desbordes horizontales a 1440 px", (await sinDesborde()) === true, String(await sinDesborde()));
  await foto("piloto-asistencia-1440");
  // estado vacío compacto: un día sin turnos
  await ev("(() => { const i = document.querySelector('.fcard input[type=date]'); i.value = '2026-01-03'; i.dispatchEvent(new Event('change')); })()");
  await hasta("document.querySelectorAll('#contenido .vacio-c').length > 0 && /No hay turnos/.test(document.getElementById('contenido').innerText)");
  check("estado vacío compacto: «No hay turnos con guardia asignado este día.» con ayuda", /No hay turnos con guardia asignado este día\./.test(await texto(".vacio-c")) && /Cambia el día o el sitio/.test(await texto(".vacio-c")));
  const alto = await ev("Math.round(document.querySelector('.vacio-c').getBoundingClientRect().height)");
  check("el estado vacío es compacto (menos de 100 px de alto)", alto < 100, `${alto} px`);
  await ev("[...document.querySelectorAll('.fcard button')].find((b) => b.textContent === 'Limpiar').click()");
  await hasta("document.querySelectorAll('#contenido .fila').length === 6");
  check("«Limpiar» regresa al día de hoy con todos los sitios", (await cuenta("#contenido .fila")) === 6);

  // =================================================================== ASISTENCIA · tableta y celular
  await ir(TAB, "asistencia");
  check("asistencia a 768 px: sin desbordes y con indicadores en 2 columnas", (await sinDesborde()) === true && (await ev("getComputedStyle(document.querySelector('.ind-grid')).gridTemplateColumns.split(' ').length")) === 2);
  await foto("piloto-asistencia-768");
  await ir(CEL, "asistencia");
  check("asistencia a 360 px: sin desbordes horizontales", (await sinDesborde()) === true, String(await sinDesborde()));
  check("celular: cada fila es una tarjeta con tira de color y etiquetas (sin encabezado de tabla)", (await ev("getComputedStyle(document.querySelector('.cab-t')).display")) === "none" && (await ev("getComputedStyle(document.querySelector('.fila')).borderTopLeftRadius")) !== "0px");
  const botones = await ev("[...document.querySelectorAll('#contenido .fila .btn')].map((b) => Math.round(b.getBoundingClientRect().height))");
  check("celular: botones de las filas de al menos 48 px", botones.length > 0 && botones.every((x) => x >= 48), botones.join(","));
  const campos360 = await ev("[...document.querySelectorAll('.fcard input, .fcard select, .fcard .btn')].map((b) => Math.round(b.getBoundingClientRect().height))");
  check("celular: campos y botones de filtros de al menos 46 px", campos360.every((x) => x >= 46), campos360.join(","));
  await foto("piloto-asistencia-360");

  // =================================================================== INCIDENCIAS · escritorio
  await ir(PC, "incidencias");
  check("incidencias: encabezado, subtítulo con el periodo y botones «Actualizar» y «CSV»", /Incidencias/.test(await texto(".pag-cab h2")) && /5 incidencia\(s\)/.test(await texto(".pag-sub")) && /Actualizar/.test(await texto(".pag-cab")) && /CSV/.test(await texto(".pag-cab")));
  const kv2 = await valores();
  check("incidencias: 4 indicadores (neutro, rojo, azul, verde)", (await cuenta("#contenido .ind")) === 4 && /5 Incidencias en el periodo \| 2 Abiertas \| 1 En atención \| 2 Cerradas/.test(kv2), kv2);
  check("«En atención»: indicador y etiquetas en ámbar con texto marino (ya no azul)", (await color("#contenido .ind:nth-child(3)")) === "rgb(254, 243, 199)" && (await color("#contenido .ind:nth-child(3) .n", "color")) === "rgb(5, 30, 62)" && (await ev("(() => { const e = [...document.querySelectorAll('#contenido .fila .etq')].find((x) => /en atención/i.test(x.textContent)); const c = getComputedStyle(e); return c.backgroundColor + '|' + c.color; })()")) === "rgb(254, 243, 199)|rgb(5, 30, 62)");
  check("«Cerrar» ya no es rojo sólido: estilo secundario (fondo blanco, borde y texto marino)", await ev("(() => { const b = [...document.querySelectorAll('#contenido .fila .c-acc button')].find((x) => x.textContent === 'Cerrar'); const c = getComputedStyle(b); return !b.className.includes('peligro') && c.backgroundColor === 'rgb(255, 255, 255)' && c.color === 'rgb(8, 45, 91)' && c.borderTopColor === 'rgb(8, 45, 91)'; })()"));
  check("escritorio: los botones de acción de cada fila van en una sola línea", await ev("[...document.querySelectorAll('#contenido .fila .c-acc')].every((a) => { const t = [...a.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top)); return t.every((x) => Math.abs(x - t[0]) <= 1); })"));
  check("filtros: Sitio, Estado, Gravedad, Desde y Hasta con etiqueta visible (3 selects + 2 fechas) y «Limpiar»", (await cuenta(".filtros-incidencias select")) === 3 && (await cuenta(".filtros-incidencias input[type=date]")) === 2 && /Desde/.test(await texto(".fcard")) && /Hasta/.test(await texto(".fcard")) && /Limpiar/.test(await texto(".fcard")));
  const fechas = await ev("[...document.querySelectorAll('.fcard input[type=date]')].map((i) => { const r = i.getBoundingClientRect(); return [Math.round(r.width), i.scrollWidth > i.clientWidth + 1]; })");
  check("campos Desde y Hasta de escritorio completos, sin cortarse", fechas.length === 2 && fechas.every(([w, c]) => w >= 170 && !c), JSON.stringify(fechas));
  check("tabla de incidencias: 5 filas con avatar, gravedad y estado", (await cuenta("#contenido .tabla-incidencias .fila")) === 5 && (await cuenta("#contenido .tabla-incidencias .fila .av")) === 5);
  check("tira: rojo (alta abierta), azul/ámbar por gravedad y verde (cerradas)", (await ev("[...document.querySelectorAll('#contenido .tabla-incidencias .fila')].map((f) => f.dataset.tira).join(',')")) === "mal,info,ambar,ok,ok");
  const grav = await ev("[...document.querySelectorAll('#contenido .fila .etq[class*=grav-]')].map((e) => e.textContent + ':' + getComputedStyle(e).backgroundColor).join(';')");
  check("etiquetas de gravedad rellenas (ALTA rojo, Media ámbar, Baja azul)", /ALTA:rgb\(220, 38, 38\)/.test(grav) && /Media:rgb\(245, 158, 11\)/.test(grav) && /Baja:rgb\(29, 106, 245\)/.test(grav), grav);
  const inc = await texto("#contenido");
  check("se conservan descripción, fotos, seguimiento, distancia y alerta de gravedad ALTA sin cerrar", /Candado forzado/.test(inc) && /Foto 1/.test(inc) && /Foto 2/.test(inc) && /Se avisó a mantenimiento/.test(inc) && /Reportada a 14 m del sitio/.test(inc) && /Incidencias de gravedad ALTA sin cerrar \(1\)/.test(inc));
  check("acciones conservadas: Comentar, En atención y Cerrar según el estado", (await ev("[...document.querySelectorAll('#contenido .fila')].map((f) => [...f.querySelectorAll('.c-acc button')].map((b) => b.textContent).join('/')).join('|')")) === "Comentar/En atención/Cerrar|Comentar/Cerrar|Comentar/En atención/Cerrar|Comentar|Comentar");
  check("sin botón «Nueva incidencia» ni folios", !/Nueva incidencia/i.test(inc) && !/INC-\d+/.test(inc));
  check("sin desbordes horizontales a 1440 px", (await sinDesborde()) === true, String(await sinDesborde()));
  await foto("piloto-incidencias-1440");
  await ev("(() => { const s = document.querySelectorAll('.filtros-incidencias select')[1]; s.value = 'cerrada'; s.dispatchEvent(new Event('change')); })()");
  await hasta("document.querySelectorAll('#contenido .tabla-incidencias .fila').length === 2");
  check("filtrar por estado «Cerrada» deja 2 filas y actualiza los indicadores", (await cuenta("#contenido .tabla-incidencias .fila")) === 2 && /2 Incidencias en el periodo \| 0 Abiertas \| 0 En atención \| 2 Cerradas/.test(await valores()), await valores());
  await ev("(() => { const s = document.querySelectorAll('.filtros-incidencias select')[2]; s.value = 'baja'; s.dispatchEvent(new Event('change')); })()");
  await hasta("document.querySelectorAll('#contenido .vacio-c').length > 0");
  check("estado vacío compacto: «No hay incidencias con esos filtros.»", /No hay incidencias con esos filtros\./.test(await texto(".vacio-c")));
  await ev("[...document.querySelectorAll('.fcard button')].find((b) => b.textContent === 'Limpiar').click()");
  await hasta("document.querySelectorAll('#contenido .tabla-incidencias .fila').length === 5");
  check("«Limpiar» restablece los filtros", (await cuenta("#contenido .tabla-incidencias .fila")) === 5);
  // formulario de seguimiento (sin cambios de función)
  await ev("[...document.querySelectorAll('#contenido .fila .c-acc button')].find((b) => b.textContent === 'Cerrar').click()");
  await hasta("!!document.querySelector('.modal textarea')");
  check("el seguimiento sigue abriendo su formulario («Cambio de estado»)", /Cambio de estado/.test(await texto(".modal")) && /Pasar la incidencia a «Cerrada»/.test(await texto(".modal")));
  await ev("document.querySelector('.modal .btn-icono').click()");

  // =================================================================== INCIDENCIAS · tableta y celular
  await ir(TAB, "incidencias");
  check("incidencias a 768 px: sin desbordes", (await sinDesborde()) === true, String(await sinDesborde()));
  await foto("piloto-incidencias-768");
  await ir(CEL, "incidencias");
  check("incidencias a 360 px: sin desbordes horizontales", (await sinDesborde()) === true, String(await sinDesborde()));
  check("celular: el primer indicador dice «En el periodo» (más corto)", (await valores()).startsWith("5 En el periodo"), await valores());
  const b2 = await ev("[...document.querySelectorAll('#contenido .fila .btn')].map((b) => Math.round(b.getBoundingClientRect().height))");
  check("celular: botones de las filas de al menos 48 px", b2.length > 0 && b2.every((x) => x >= 48), b2.join(","));
  await foto("piloto-incidencias-360");

  check("sin excepciones de JavaScript durante toda la prueba", errores.length === 0, errores.slice(0, 2).join(" | "));
  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS DEL PILOTO (ASISTENCIA E INCIDENCIAS) PASARON");
  sock.close();
  process.exitCode = fallos ? 1 : 0;
} finally {
  try { spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ya terminó */ }
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
