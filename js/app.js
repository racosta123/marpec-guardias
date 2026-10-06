import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithCustomToken, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, getFirestore, doc, getDoc,
} from "./vendor/firebase.js";
import { config } from "./config.js";
import { crearApi } from "./api.js";
import { confirmar, h, limpiar } from "./ui.js";
import { vistaGuardia, turnoVigenteId } from "./vistas/guardia.js";
import { cargarReloj, contarPendientes, metaGet, metaSet, sincronizarReloj, vaciarTodo } from "./cola.js";
import { detenerEnvio, enviarPendientes, iniciarEnvio, montarBarraSync } from "./envio.js";
import { desmontarPanico, montarPanico } from "./panico.js";
import { detenerAlertasPanico, iniciarAlertasPanico } from "./alertas.js";
import { vistaVivo } from "./vistas/vivo.js";
import { vistaOffline } from "./vistas/offline.js";
import { vistaAlertas } from "./vistas/alertas.js";
import { vistaPersonal } from "./vistas/personal.js";
import { vistaSitios } from "./vistas/sitios.js";
import { vistaTurnos } from "./vistas/turnos.js";
import { vistaEmpresa } from "./vistas/empresa.js";
import { vistaBitacora } from "./vistas/bitacora.js";
import { vistaAsistencia } from "./vistas/asistencia.js";
import { vistaReportes } from "./vistas/reportes.js";
import { vistaRondines } from "./vistas/rondines.js";
import { vistaIncidencias } from "./vistas/incidencias.js";
import { vistaVisitantes } from "./vistas/visitantes.js";
import { vistaBitacoras } from "./vistas/bitacoras.js";
import { debeAvisar, estadoLicencia, textoBanner } from "./licencia.js";
import { icono } from "./iconos.js";

const app = initializeApp(config.firebase);
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const db = getFirestore(app);
const api = crearApi(auth);

const $ = (id) => document.getElementById(id);
const vistas = { login: $("vista-login"), inicio: $("vista-inicio"), demo: $("vista-demo") };
const ROLES = {
  guardia: { etiqueta: "Guardia", titulo: "MARPEC · Guardia" },
  supervisor: { etiqueta: "Supervisor", titulo: "MARPEC · Supervisión" },
  admin: { etiqueta: "Administrador", titulo: "MARPEC · Administración" },
};

// Secciones por rol. El supervisor solo ve turnos y sitios propios; el resto es del admin.
// [clave, etiqueta, vista, ícono]
const SECCIONES = {
  supervisor: [["vivo", "En vivo", vistaVivo, "envivo"], ["asistencia", "Asistencia", vistaAsistencia, "asistencia"], ["rondines", "Rondines", vistaRondines, "rondines"], ["incidencias", "Incidencias", vistaIncidencias, "incidencias"], ["visitantes", "Visitantes", vistaVisitantes, "visitantes"], ["bitacoras", "Bitácoras", vistaBitacoras, "bitacoras"], ["offline", "Sin conexión", vistaOffline, "sinconexion"], ["alertas", "Alertas", vistaAlertas, "alertas"], ["turnos", "Turnos", vistaTurnos, "turnos"], ["sitios", "Mis sitios", vistaSitios, "sitios"]],
  admin: [["vivo", "En vivo", vistaVivo, "envivo"], ["asistencia", "Asistencia", vistaAsistencia, "asistencia"], ["rondines", "Rondines", vistaRondines, "rondines"], ["incidencias", "Incidencias", vistaIncidencias, "incidencias"], ["visitantes", "Visitantes", vistaVisitantes, "visitantes"], ["bitacoras", "Bitácoras", vistaBitacoras, "bitacoras"], ["offline", "Sin conexión", vistaOffline, "sinconexion"], ["alertas", "Alertas", vistaAlertas, "alertas"], ["turnos", "Turnos", vistaTurnos, "turnos"], ["sitios", "Sitios", vistaSitios, "sitios"], ["personal", "Personal", vistaPersonal, "personal"], ["reportes", "Reportes", vistaReportes, "reportes"], ["empresa", "Empresa", vistaEmpresa, "empresa"], ["bitacora", "Bitácora", vistaBitacora, "auditoria"]],
};

// Sesión activa: para cerrarla limpiamente (cola local, botón de pánico, alertas).
let rolActual = null;
let limpiezaVista = null; // una vista en tiempo real devuelve la función que cancela sus listeners
function detenerSesion() {
  document.body.classList.remove("menu-abierto");
  delete document.body.dataset.rol;
  $("btn-menu").hidden = true; $("btn-campana").hidden = true;
  if (limpiezaVista) { limpiezaVista(); limpiezaVista = null; }
  detenerEnvio(); desmontarPanico(); detenerAlertasPanico();
  const b = $("barra-sync");
  if (b) { b.hidden = true; limpiar(b); }
}

async function montarApp(ctx) {
  const raiz = $("contenido");
  rolActual = ctx.user.rol;
  document.body.dataset.rol = ctx.user.rol; // el diseño (menú lateral, encabezado, fondo) depende del rol
  aplicarLicencia(); // banner de "próximo a vencer" para admin y supervisores
  if (ctx.user.rol === "guardia") {
    // Modo sin internet: cola local + envío automático + indicador + botón de pánico en todas las pantallas
    iniciarEnvio({ api: ctx.api, uid: ctx.user.uid });
    montarBarraSync($("barra-sync"));
    montarPanico($("panico-raiz"), { getTurnoId: turnoVigenteId });
  } else {
    iniciarAlertasPanico({ db: ctx.db, api: ctx.api, user: ctx.user }); // sonido y aviso hasta que alguien atienda
  }
  const nav = $("tabs-app");
  const secciones = SECCIONES[ctx.user.rol];
  nav.hidden = !secciones;
  limpiar(nav);
  const abrir = async (clave) => {
    for (const b of nav.children) b.setAttribute("aria-current", String(b.dataset.clave === clave));
    const s = secciones.find((x) => x[0] === clave);
    if (limpiezaVista) { limpiezaVista(); limpiezaVista = null; }
    try { const r = await s[2](raiz, ctx); if (typeof r === "function") limpiezaVista = r; }
    catch { limpiar(raiz); raiz.append(h("p", { class: "error" }, "No fue posible cargar esta sección. Intenta de nuevo.")); }
  };
  if (!secciones) {
    try { await vistaGuardia(raiz, ctx); } catch { limpiar(raiz); raiz.append(h("p", { class: "error" }, "No fue posible cargar tu turno.")); }
    return;
  }
  for (const [clave, etiqueta, , ico] of secciones)
    nav.append(h("button", { type: "button", class: "tab-app", "data-clave": clave, onclick: () => { cerrarMenu(); abrir(clave); } }, icono(ico, { tam: 20 }), etiqueta));
  prepararEncabezado(() => abrir("alertas"));
  await abrir(secciones[0][0]);
}

$("btn-salir").prepend(icono("salida", { tam: 18 }));
$("btn-salir").setAttribute("aria-label", "Salir");

// ---- Encabezado y menú (supervisor / admin): menú desplegable en celular, campana de alertas, avatar ----
function cerrarMenu() {
  document.body.classList.remove("menu-abierto");
  $("btn-menu").setAttribute("aria-expanded", "false");
}
function prepararEncabezado(abrirAlertas) {
  const menu = $("btn-menu"), campana = $("btn-campana"), avatar = $("topbar-avatar");
  menu.hidden = false; campana.hidden = false;
  limpiar(menu); menu.append(icono("menu", { tam: 24 }));
  limpiar(campana); campana.append(icono("alertas", { tam: 22 }), h("span", { class: "campana-n", id: "campana-n", hidden: true }));
  limpiar(avatar); avatar.append(icono("usuario", { tam: 24 }));
  menu.onclick = () => { const abierto = document.body.classList.toggle("menu-abierto"); menu.setAttribute("aria-expanded", String(abierto)); };
  campana.onclick = abrirAlertas;
}
document.addEventListener("click", (e) => { if (document.body.classList.contains("menu-abierto") && !e.target.closest("#tabs-app, #btn-menu")) cerrarMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarMenu(); });
// alertas.js avisa cuántas alertas de pánico hay activas: el número se ve en la campana (y se anuncia a lectores de pantalla)
window.addEventListener("panico-activas", (e) => {
  const n = Number(e.detail) || 0, c = $("btn-campana"), b = $("campana-n");
  if (!b) return;
  b.hidden = n === 0; b.textContent = String(n);
  c.setAttribute("aria-label", n ? `Alertas: ${n} de pánico activa${n === 1 ? "" : "s"}` : "Alertas");
});

function mostrar(nombre) {
  if (licencia?.vencido) nombre = "demo"; // demo concluida: la pantalla reemplaza al login y a la app
  $("cargando").hidden = true;
  for (const [k, el] of Object.entries(vistas)) el.hidden = k !== nombre;
}

// ---- Licencia de demostración ----
// El Worker (403 "demo_vencido") y las reglas de Firestore son la barrera real; aquí solo se avisa y se muestra la pantalla.
let licencia = null; // último estado conocido (null = no se pudo consultar: no se bloquea nada)
function aplicarLicencia() {
  const banner = $("banner-licencia");
  if (licencia?.vencido) { detenerSesion(); banner.hidden = true; mostrar("demo"); return; }
  const ver = debeAvisar(licencia, rolActual);
  banner.hidden = !ver;
  if (ver) banner.textContent = textoBanner(licencia);
}
async function revisarLicencia() {
  const e = await estadoLicencia();
  if (e) { licencia = e; aplicarLicencia(); }
}
const licenciaLista = revisarLicencia();
setInterval(revisarLicencia, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") revisarLicencia(); });
window.addEventListener("demo-vencido", () => { licencia = { modo: "demo", vencido: true }; aplicarLicencia(); }); // lo emite api.js ante un 403 demo_vencido

function error(msg) {
  const el = $("login-error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

// ---- Pestañas del login ----
function elegirTab(cual) {
  const guardia = cual === "guardia";
  $("tab-guardia").setAttribute("aria-selected", String(guardia));
  $("tab-admin").setAttribute("aria-selected", String(!guardia));
  $("form-guardia").hidden = !guardia;
  $("form-admin").hidden = guardia;
  error("");
}
$("tab-guardia").addEventListener("click", () => elegirTab("guardia"));
$("tab-admin").addEventListener("click", () => elegirTab("admin"));

function ocupado(form, on) {
  const b = form.querySelector("button[type=submit]");
  b.disabled = on;
}

// ---- Acceso de guardia: número de empleado + PIN (verificado por el Worker) ----
$("form-guardia").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  error("");
  const numero = $("numero").value.trim().toUpperCase();
  const pin = $("pin").value;
  if (!/^[A-Z0-9]{3,12}$/.test(numero) || !/^\d{4,6}$/.test(pin)) {
    error("Escribe tu número de empleado y tu PIN de 4 a 6 dígitos.");
    return;
  }
  ocupado(form, true);
  try {
    const res = await fetch(`${config.workerUrl}/auth/guardia`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ numero, pin }),
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (res.status === 403) { // ¿demo concluida? (el Worker responde 403 "demo_vencido"; cualquier otro 403 sigue siendo error genérico)
      const j = await res.json().catch(() => ({}));
      if (j.error === "demo_vencido") { window.dispatchEvent(new Event("demo-vencido")); return; }
    }
    if (!res.ok) {
      error("Número de empleado o PIN incorrectos, o acceso bloqueado temporalmente.");
      return;
    }
    sincronizarReloj(Number(res.headers.get("x-server-time")));
    const { token } = await res.json();
    await signInWithCustomToken(auth, token);
  } catch {
    error("No fue posible conectar. Revisa tu conexión e intenta de nuevo.");
  } finally {
    $("pin").value = "";
    ocupado(form, false);
  }
});

// ---- Acceso de supervisor/admin: correo + contraseña (Firebase Auth) ----
$("form-admin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  error("");
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    error("Escribe tu correo y tu contraseña.");
    return;
  }
  ocupado(form, true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    const red = err && err.code === "auth/network-request-failed";
    error(red ? "No fue posible conectar. Revisa tu conexión e intenta de nuevo." : "Correo o contraseña incorrectos.");
  } finally {
    $("password").value = "";
    ocupado(form, false);
  }
});

async function cerrarSesion() {
  detenerSesion();
  await vaciarTodo(); // la cola local, las copias y el reloj se borran al cerrar sesión
  await signOut(auth);
}
$("btn-salir").addEventListener("click", async () => {
  if (rolActual === "guardia" && auth.currentUser) {
    if (navigator.onLine !== false) await enviarPendientes();
    const n = await contarPendientes(auth.currentUser.uid);
    if (n > 0 && !(await confirmar("Registros sin enviar", `Tienes ${n} registro(s) sin enviar. Si cierras sesión se BORRARÁN de este celular y se perderán. ¿Cerrar sesión de todos modos?`, "Cerrar sesión y borrarlos", true))) return;
  }
  await cerrarSesion();
});

// ---- Estado de sesión ----
onAuthStateChanged(auth, async (user) => {
  await licenciaLista;
  if (licencia?.vencido) { detenerSesion(); mostrar("demo"); return; } // los datos se conservan; solo se detiene el uso
  if (!user) {
    detenerSesion();
    await vaciarTodo(); // sin sesión no queda nada de la cola local
    limpiar($("contenido"));
    limpiar($("tabs-app"));
    mostrar("login");
    return;
  }
  await cargarReloj();
  try {
    let rol, nombre, numero = "", desdeCopia = false;
    try {
      const { claims } = await user.getIdTokenResult(true); // el rol viene SOLO del token emitido por el Worker
      rol = claims.rol;
      if (!ROLES[rol]) { await cerrarSesion(); error("Esta cuenta no tiene acceso a la aplicación."); return; }
      // Reglas de Firestore: cada persona lee solo su propio perfil.
      const snap = await getDoc(doc(db, "usuarios", user.uid));
      if (!snap.exists() || snap.data().activo !== true) { await cerrarSesion(); error("Esta cuenta no tiene acceso a la aplicación."); return; }
      nombre = snap.data().nombre;
      numero = snap.data().numeroEmpleado || ""; // solo para mostrarlo en el inicio del guardia (ya viene en el perfil; sin lecturas nuevas)
      metaSet("identidad", { uid: user.uid, rol, nombre, numero });
    } catch (e) {
      // Sin conexión NO se cierra la sesión (y no se pierde lo capturado): se usa la identidad validada la última vez.
      const copia = await metaGet("identidad");
      if (copia && copia.uid === user.uid && ROLES[copia.rol] && (navigator.onLine === false || !e?.code || /network|unavailable|offline/i.test(String(e.code)))) { rol = copia.rol; nombre = copia.nombre; numero = copia.numero || ""; desdeCopia = true; }
      else throw e;
    }
    const info = ROLES[rol];
    $("inicio-titulo").textContent = info.titulo;
    $("nombre").textContent = nombre;
    $("rol").textContent = desdeCopia ? `${info.etiqueta} · sin conexión` : info.etiqueta;
    mostrar("inicio");
    await montarApp({ db, api, auth, user: { uid: user.uid, rol, nombre, numero } });
  } catch {
    // No se pudo validar y tampoco hay copia: se queda en el login SIN cerrar la sesión (se reintenta al reabrir).
    await revisarLicencia(); // si la causa es la demo concluida (reglas de Firestore), se muestra su pantalla
    mostrar("login");
    error("No fue posible validar tu acceso. Revisa tu conexión e intenta de nuevo.");
  }
});

// ---- PWA ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
