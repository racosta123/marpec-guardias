import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithCustomToken, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, getFirestore, doc, getDoc,
} from "./vendor/firebase.js";
import { config } from "./config.js";

const app = initializeApp(config.firebase);
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const vistas = { login: $("vista-login"), inicio: $("vista-inicio") };
const ROLES = {
  guardia: { etiqueta: "Guardia", titulo: "MARPEC · Guardia", vacio: "Aquí aparecerán tus turnos, rondines y registros. (Fase 1: solo acceso)" },
  supervisor: { etiqueta: "Supervisor", titulo: "MARPEC · Supervisión", vacio: "Aquí aparecerá el panel de supervisión. (Fase 1: solo acceso)" },
  admin: { etiqueta: "Administrador", titulo: "MARPEC · Administración", vacio: "Aquí aparecerá el panel de administración. (Fase 1: solo acceso)" },
};

function mostrar(nombre) {
  $("cargando").hidden = true;
  for (const [k, el] of Object.entries(vistas)) el.hidden = k !== nombre;
}

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
    if (!res.ok) {
      error("Número de empleado o PIN incorrectos, o acceso bloqueado temporalmente.");
      return;
    }
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

$("btn-salir").addEventListener("click", () => signOut(auth));

// ---- Estado de sesión ----
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    mostrar("login");
    return;
  }
  try {
    const { claims } = await user.getIdTokenResult(true); // el rol viene SOLO del token emitido por el Worker
    const info = ROLES[claims.rol];
    if (!info) {
      await signOut(auth);
      error("Esta cuenta no tiene acceso a la aplicación.");
      return;
    }
    // Reglas de Firestore: cada persona lee solo su propio perfil.
    const snap = await getDoc(doc(db, "usuarios", user.uid));
    if (!snap.exists() || snap.data().activo !== true) {
      await signOut(auth);
      error("Esta cuenta no tiene acceso a la aplicación.");
      return;
    }
    $("inicio-titulo").textContent = info.titulo;
    $("nombre").textContent = snap.data().nombre;
    $("rol").textContent = info.etiqueta;
    $("vacio").textContent = info.vacio;
    mostrar("inicio");
  } catch {
    await signOut(auth).catch(() => {});
    error("No fue posible validar tu acceso. Intenta de nuevo.");
  }
});

// ---- PWA ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
