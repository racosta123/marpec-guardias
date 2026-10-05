// Prueba de la interfaz de la Fase 5 con Chrome real (cámara y GPS simulados por Chrome).
// Uso: node tests/ui/fase5.cdp.mjs http://localhost:5182   (servidor: node tools/serve.mjs 5182 --fake)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("uso: node tests/ui/fase5.cdp.mjs <urlBase>");
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const perfil = mkdtempSync(join(tmpdir(), "cdp-"));
const puerto = 9500 + Math.floor(Math.random() * 100);
const proc = spawn(CHROME, [`--remote-debugging-port=${puerto}`, `--user-data-dir=${perfil}`, "--headless=new", "--no-first-run", "--disable-gpu", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "about:blank"], { stdio: "ignore" });
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
  await cmd("Emulation.setGeolocationOverride", { latitude: 29.0729, longitude: -110.9559, accuracy: 8 });
  const ir = async (u, ms = 3500) => { await cmd("Page.navigate", { url: `${base}${u}` }); await espera(ms); };
  const texto = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ""`);
  const conTexto = async (sel, re, ms = 8000) => { const fin = Date.now() + ms; let t = ""; do { t = await texto(sel); if (re.test(t)) return t; await espera(250); } while (Date.now() < fin); return t; };
  const clic = (re, sel = "button") => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent) && !x.hidden && !x.disabled); if (b) b.click(); return Boolean(b); })()`);
  const llamada = async (ruta) => JSON.parse(await ev(`JSON.stringify([...window.__llamadas].reverse().find((l) => l.ruta === ${JSON.stringify(ruta)}) || null)`));

  // ---------------- GUARDIA ----------------
  await ir("/index.html?rol=guardia&entrada=1");
  const home = await texto("#contenido");
  check("guardia con entrada: «Libro del turno» con Novedad, Incidencia, Visitantes y Bitácora", /Libro del turno/i.test(home) && /Novedad/i.test(home) && /Incidencia/i.test(home) && /Visitantes/i.test(home) && /Bitácora/i.test(home));
  check("al cambio de turno el entrante ve quién sigue dentro (turno anterior)", /Del turno anterior siguen dentro: Pedro Sigue Dentro/i.test(await conTexto("#contenido", /Pedro Sigue Dentro/i)));
  check("el botón de visitantes muestra cuántos hay dentro", /1 dentro/i.test(await conTexto("#contenido", /1 dentro/i)));

  await clic("/Novedad/i", ".libro-btn");
  await espera(300);
  await ev("window.__llamadas.length = 0; document.querySelector('.modal textarea').value = 'Se cambió la bombilla del pasillo.'; document.querySelector('.modal form').requestSubmit()");
  await espera(700);
  const nv = await llamada("/novedades");
  check("novedad: se envía solo turno y texto (el servidor pone la hora)", Boolean(nv) && nv.body.turnoId === "t5" && nv.body.texto === "Se cambió la bombilla del pasillo." && Object.keys(nv.body).filter((k) => k !== "sync").sort().join() === "texto,turnoId", JSON.stringify(nv?.body));

  await clic("/Incidencia/i", ".libro-btn");
  const m1 = await conTexto(".modal", /Tipo de incidencia/i);
  const opciones = await ev("[...document.querySelectorAll('.modal select')][0].options.length");
  check("incidencia: catálogo de tipos (7) y gravedad baja/media/alta", /Tipo de incidencia/i.test(m1) && opciones === 7 && /ALTA/i.test(m1) && /Agregar foto \(máx\. 3\)/i.test(m1));
  await ev("const s = document.querySelectorAll('.modal select'); s[0].value = 'acceso_no_autorizado'; s[1].value = 'alta'; document.querySelector('.modal textarea').value = 'Persona forzando la reja del estacionamiento.'");
  for (let i = 0; i < 3; i++) {
    await ev("[...document.querySelectorAll('.modal > .modal-cuerpo button, .modal button')].find((b) => /Agregar foto/i.test(b.textContent) && !b.hidden).click()");
    await conTexto(".modal:last-of-type", /Tomar foto/i);
    await espera(1300);
    await ev("[...document.querySelectorAll('button')].find((b) => /Tomar foto/i.test(b.textContent)).click()");
    await espera(1500);
  }
  check("incidencia: hasta 3 fotos con la cámara en vivo; al llegar a 3 ya no se ofrece más", (await ev("document.querySelectorAll('.fotos-inc img').length")) === 3 && (await ev("![...document.querySelectorAll('button')].some((b) => /Agregar foto/i.test(b.textContent) && !b.hidden)")) === true);
  check("incidencia: sin selector de archivos (no hay galería)", (await ev("document.querySelectorAll('input[type=file]').length")) === 0);
  await ev("window.__llamadas.length = 0; document.querySelector('.modal form').requestSubmit()");
  await espera(1200);
  const ic = await llamada("/incidencias");
  check("incidencia: envía tipo, gravedad alta, descripción, 3 fotos JPEG y GPS", Boolean(ic) && ic.body.tipoId === "acceso_no_autorizado" && ic.body.gravedad === "alta" && ic.body.fotos.length === 3 && ic.body.fotos.every((f) => Buffer.from(f, "base64")[0] === 0xff) && Math.abs(ic.body.lat - 29.0729) < 0.001 && typeof ic.body.horaDispositivoMs === "number");

  await clic("/Visitantes/i", ".libro-btn");
  const vm = await conTexto(".modal", /Dentro del sitio ahora/i);
  check("visitantes: lista «dentro del sitio ahora» con quién y cuándo entró", /Luis Pérez/.test(vm) && /placas ABC-123/.test(vm));
  await clic("/Registrar salida/i");
  await espera(600);
  const so = await llamada("/visitantes/salida");
  check("visitante: registrar salida (turno y visitante)", Boolean(so) && so.body.turnoId === "t5" && so.body.visitanteId === "v1");
  await conTexto(".modal", /REGISTRAR ENTRADA/i);
  await clic("/REGISTRAR ENTRADA/i");
  const fv = await conTexto(".modal", /Nombre del visitante/i);
  check("visitantes: advertencia de NO pedir ni fotografiar identificaciones", /No pidas ni fotografíes identificaciones \(INE, licencia, pasaporte\)/i.test(fv));
  const camposForm = await ev("JSON.stringify([...document.querySelectorAll('.modal form label')].map((l) => l.innerText.trim().toLowerCase()))");
  check("visitantes: el formulario NO tiene ningún campo de identificación", !/ine\\b|licencia|pasaporte|identificaci[oó]n|curp|n[uú]mero de/.test(JSON.parse(camposForm).join(" ").replace(/no pidas[^"]*/g, "")), camposForm.slice(0, 140));
  check("visitantes: sin selector de archivos; foto opcional solo del vehículo o la placa", (await ev("document.querySelectorAll('input[type=file]').length")) === 0 && /Foto del vehículo o la placa \(opcional\)/i.test(fv));
  await ev("window.__llamadas.length = 0; const f = document.querySelector('.modal form'); const t = f.querySelectorAll('input[type=text]'); t[0].value = 'Carlos Servicio'; t[1].value = 'Casa 5'; f.querySelector('select').value = 'servicio'; t[2].value = 'Plomería SA'; t[3].value = 'xyz-789'; f.requestSubmit()");
  await espera(900);
  const ve = await llamada("/visitantes/entrada");
  check("visitante: entrada con exactamente los campos permitidos (sin identificaciones)", Boolean(ve) && Object.keys(ve.body).filter((k) => k !== "sync").sort().join() === "empresa,motivo,nombre,placas,turnoId,visitaA" && ve.body.motivo === "servicio", JSON.stringify(ve && Object.keys(ve.body)));

  await ev("document.querySelector('.modal .btn-icono') && document.querySelector('.modal .btn-icono').click()");
  await espera(300);
  await clic("/Bitácora/i", ".libro-btn");
  const bt = await conTexto(".modal", /Turno anterior del sitio/i);
  check("bitácora: línea de tiempo del turno y bitácora del turno anterior", /Entrada al turno/i.test(bt) && /bombilla/i.test(bt) && /Incidencia \(alta\)/i.test(bt) && /Portón 2 con falla/i.test(bt) && /Siguen dentro del sitio: Pedro Sigue Dentro/i.test(bt));

  // ---------------- SUPERVISOR ----------------
  await ir("/index.html?rol=supervisor");
  const tabs = await ev("[...document.querySelectorAll('.tab-app')].map((b) => b.textContent).join(',')");
  check("supervisor: pestañas Incidencias, Visitantes y Bitácoras", /Incidencias/.test(tabs) && /Visitantes/.test(tabs) && /Bitácoras/.test(tabs), tabs);
  await ev("document.querySelector('[data-clave=incidencias]').click()");
  const inc = await conTexto("#contenido", /gravedad ALTA sin cerrar/i);
  check("incidencias: alerta destacada de gravedad ALTA sin cerrar", /gravedad ALTA sin cerrar \(1\)/i.test(inc) && /Candado forzado/.test(inc));
  check("incidencias: solo las de SU sitio (no «otro sitio»)", !/otro sitio/i.test(inc) && /Falla eléctrica/.test(inc));
  check("incidencias: filtros por sitio, estado, gravedad y fechas; fotos y seguimiento", (await ev("document.querySelectorAll('.filtros-incidencias select').length")) === 3 && (await ev("document.querySelectorAll('.filtros-incidencias input[type=date]').length")) === 2 && /Foto 1/i.test(inc) && /Se avisó a mantenimiento/.test(inc));
  await ev("window.__llamadas.length = 0");
  await clic("/^En atención$/");
  await espera(300);
  await ev("document.querySelector('.modal textarea').value = 'Policía en camino.'; document.querySelector('.modal form').requestSubmit()");
  await espera(700);
  const sg = await llamada("/incidencias/seguimiento");
  check("seguimiento: cambio de estado como registro nuevo (no edita el original)", Boolean(sg) && sg.body.tipo === "estado" && sg.body.estadoNuevo === "en_atencion" && sg.body.incidenciaId === "i1");
  await clic("/^Comentar$/");
  await espera(300);
  await ev("window.__llamadas.length = 0; document.querySelector('.modal textarea').value = 'Se revisó el portón.'; document.querySelector('.modal form').requestSubmit()");
  await espera(700);
  const cm = await llamada("/incidencias/seguimiento");
  check("seguimiento: comentario nuevo", Boolean(cm) && cm.body.tipo === "comentario" && /portón/.test(cm.body.texto));
  const csvI = await ev(`(async () => { const m = await import('/js/vistas/incidencias.js'); return m.incidenciasACsv([{ creadoMs: 1790000000000, sitioNombre: '=cmd', tipoNombre: 'Robo', gravedad: 'alta', estado: 'abierta', guardiaNombre: 'Gael, "G"', descripcion: '@x +y', nFotos: 2, seguimientos: [{ tsMs: 1790000100000, autorNombre: 'Sara', tipo: 'estado', estadoNuevo: 'cerrada', texto: '-cerrado' }] }]); })()`);
  check("CSV de incidencias: BOM, escapa y neutraliza fórmulas", csvI.startsWith("\ufeff") && /'=cmd/.test(csvI) && /"Gael, ""G"""/.test(csvI) && /'@x/.test(csvI));

  await ev("document.querySelector('[data-clave=visitantes]').click()");
  const vp = await conTexto("#contenido", /Dentro ahora/i);
  check("visitantes (supervisor): dentro ahora de SU sitio; no los de otro", /Luis Pérez/.test(vp) && !/otro sitio/i.test(vp) && /Cartel de aviso/i.test(vp));
  const csvV = await ev(`(async () => { const m = await import('/js/vistas/visitantes.js'); return m.visitantesACsv([{ entradaMs: 1790000000000, sitioNombre: 'S', nombre: '=HYPERLINK("x")', visitaA: 'A', motivo: 'visita', empresa: '', placas: '', salidaMs: null, guardiaNombre: 'G', fotoKey: null }]); })()`);
  check("CSV de visitantes: BOM, DENTRO y fórmulas neutralizadas; sin columnas de identificación", csvV.startsWith("\ufeff") && /DENTRO/.test(csvV) && /'=HYPERLINK/.test(csvV) && !/ine|licencia|pasaporte|identific/i.test(csvV.split("\r\n")[0]));

  await ev("document.querySelector('[data-clave=bitacoras]').click()");
  await conTexto("#contenido", /Ver bitácora/i);
  await clic("/Ver bitácora/i");
  const bm = await conTexto(".modal", /Entrada al turno/i);
  check("bitácoras (supervisor): vista consolidada por turno y exportación CSV", /Novedad/i.test(bm) && /Exportar CSV/i.test(bm));
  const csvB = await ev(`(async () => { const m = await import('/js/vistas/bitacoras.js'); return m.bitacoraACsv({ sitioNombre: 'S', guardiaNombre: 'G', items: [{ tsMs: 1790000000000, tipo: 'novedad', titulo: 'Novedad', detalle: '=1+1' }] }); })()`);
  check("CSV de bitácora: fórmulas neutralizadas", /'=1\+1/.test(csvB));

  // ---------------- ADMIN ----------------
  await ir("/index.html?rol=admin");
  await ev("document.querySelector('[data-clave=empresa]').click()");
  const emp = await conTexto("#contenido", /Tipos de incidencia/i);
  check("empresa: retención de visitantes (90 días) y catálogo de tipos de incidencia", /Retención de registros y fotos de visitantes/i.test(emp) && (await ev("[...document.querySelectorAll('#contenido input[type=number]')].some((i) => i.value === '90' && i.max === '1825')")) === true && (await ev("document.querySelectorAll('.tipo-fila').length")) === 7);
  await ev("window.__llamadas.length = 0; const f = document.querySelectorAll('#contenido form')[1]; const filas = f.querySelectorAll('.tipo-fila'); filas[1].querySelector('input[type=checkbox]').checked = false; f.requestSubmit()");
  await espera(700);
  const cat = await llamada("/admin/catalogo-incidencias");
  check("catálogo: guarda tipos (desactivar «Robo»); no hay forma de eliminarlos", Boolean(cat) && cat.body.tipos.length === 7 && cat.body.tipos.find((t) => t.id === "robo").activo === false && !(await ev("[...document.querySelectorAll('.tipo-fila button')].length")));
  await ir("/aviso-visitantes.html", 1500);
  const av = await texto("body");
  check("cartel de aviso para visitantes (borrador imprimible): sin identificaciones, retención y ARCO", /NO te pedimos ni guardamos identificaciones/i.test(av) && /90/.test(av) && /ARCO/i.test(av) && /BORRADOR/i.test(av));

  check("sin excepciones de JavaScript durante toda la prueba", errores.length === 0, errores.slice(0, 2).join(" | "));
  console.log(fallos ? `\n${fallos} PRUEBA(S) FALLARON` : "\nTODAS LAS PRUEBAS DE INTERFAZ (FASE 5) PASARON");
  sock.close();
  process.exitCode = fallos ? 1 : 0;
} finally {
  proc.kill();
  await espera(500);
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* perfil en uso */ }
}
