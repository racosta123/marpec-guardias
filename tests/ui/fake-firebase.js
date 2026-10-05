// Sustituto en memoria del SDK de Firebase SOLO para probar la interfaz en el navegador (tests/ui).
// Se inyecta con un import map desde tools/serve.mjs --fake. Nunca se publica con la app.
const DIA = 86400000;
const p = new URLSearchParams(location.search);
const ROL = p.get("rol") || "admin";
const UID = { admin: "adm1", supervisor: "sup1", guardia: "g-G001" }[ROL];

const ahora = Date.now();
const lunes0 = (() => {
  const d = new Date(ahora - 7 * 3600e3);
  const dow = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) + 7 * 3600e3;
})();
const t = (dia, h1, h2, sitioId, guardiaUid, sup) => ({
  sitioId, sitioNombre: sitioId === "siteA" ? "Plaza Norte" : "Bodega Sur", supervisorUid: sup, guardiaUid,
  inicioMs: lunes0 + dia * DIA + h1 * 3600e3, finMs: lunes0 + dia * DIA + h2 * 3600e3, plantilla: "diurno", estado: "programado",
});

export const store = {
  usuarios: {
    adm1: { nombre: "Ana Admin", rol: "admin", activo: true },
    sup1: { nombre: "Sara Supervisora", rol: "supervisor", activo: true, email: "sara@marpec.mx" },
    sup2: { nombre: "Saúl Supervisor", rol: "supervisor", activo: true, email: "saul@marpec.mx" },
    "g-G001": { nombre: "Gael Guardia", rol: "guardia", numeroEmpleado: "G001", activo: true, sitiosAsignados: ["siteA"] },
    "g-G002": { nombre: "Gema Guardia", rol: "guardia", numeroEmpleado: "G002", activo: true, sitiosAsignados: [] },
    "g-G003": { nombre: "Beto Baja", rol: "guardia", numeroEmpleado: "G003", activo: false, prueba: true },
  },
  sitios: {
    siteA: { nombre: "Plaza Norte", cliente: "ACME", direccion: "Blvd. Kino 100", consignas: "1. Registrar visitantes.\n2. Rondín cada 2 horas.", supervisorUid: "sup1", lat: 29.0729, lng: -110.9559, precisionM: 12, radioM: 100, qrVersion: 1, activo: true },
    siteB: { nombre: "Bodega Sur", cliente: "Logística SA", direccion: "Calle 5", consignas: "", supervisorUid: "sup2", lat: null, lng: null, radioM: 100, qrVersion: 1, activo: true },
  },
  turnos: {
    t1: t(0, 7, 19, "siteA", "g-G001", "sup1"),
    t2: t(1, 7, 19, "siteA", null, "sup1"),
    t3: t(2, 19, 31, "siteA", "g-G001", "sup1"),
    t4: t(0, 7, 19, "siteB", "g-G002", "sup2"),
  },
  configuracion: { empresa: { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3 } },
  auditoria: {
    e1: { actorNombre: "Ana Admin", actorUid: "adm1", actorRol: "admin", accion: "sitio.alta", objetivo: "siteA", detalle: "{\"nombre\":\"Plaza Norte\"}", ts: { toMillis: () => ahora - 3600e3 } },
  },
};
window.__store = store;
// Próximo turno del guardia de prueba (en 2 h)
store.turnos.t5 = { sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaUid: "g-G001", inicioMs: ahora + 20 * 60e3, finMs: ahora + 12.33 * 3600e3, plantilla: "diurno", estado: "programado" };
// Asistencias simuladas (las calcula el Worker en producción)
const dia = (ms) => new Date(ms - 7 * 3600e3).toISOString().slice(0, 10);
store.asistencias = {
  t1: { turnoId: "t1", sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaUid: "g-G001", guardiaNombre: "Gael Guardia", inicioMs: store.turnos.t1.inicioMs, finMs: store.turnos.t1.finMs, fecha: dia(store.turnos.t1.inicioMs),
    estado: "cumplido", entradaMs: store.turnos.t1.inicioMs + 15 * 60e3, salidaMs: store.turnos.t1.finMs + 50 * 60e3, retardo: true, retardoMin: 15, falta: false, minutosExtra: 50, extraEstado: "pendiente", extraEnCurso: false,
    fotoEntrada: true, fotoSalida: true, entradaDistanciaM: 12, entradaPrecisionM: 9, notasEntrega: "Portón 2 con falla.", ajustes: 0, relevoAlerta: false },
  t4: { turnoId: "t4", sitioId: "siteB", sitioNombre: "Bodega Sur", supervisorUid: "sup2", guardiaUid: "g-G002", guardiaNombre: "Gema Guardia", inicioMs: store.turnos.t4.inicioMs, finMs: store.turnos.t4.finMs, fecha: dia(store.turnos.t4.inicioMs),
    estado: "falta", entradaMs: null, salidaMs: null, retardo: false, falta: true, motivoFalta: "sin_entrada", minutosExtra: 0, extraEstado: "ninguno", relevoAlerta: false, ajustes: 0 },
  t5: { turnoId: "t5", sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaUid: "g-G001", guardiaNombre: "Gael Guardia", inicioMs: store.turnos.t5.inicioMs, finMs: store.turnos.t5.finMs, fecha: dia(store.turnos.t5.inicioMs),
    estado: "por_marcar", entradaMs: null, salidaMs: null, retardo: false, falta: false, minutosExtra: 0, extraEstado: "ninguno", relevoAlerta: false, ajustes: 0, ventanaEntradaDesdeMs: store.turnos.t5.inicioMs - 30 * 60e3 },
  t3: { turnoId: "t3", sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaUid: "g-G001", guardiaNombre: "Gael Guardia", inicioMs: store.turnos.t3.inicioMs, finMs: store.turnos.t3.finMs, fecha: dia(store.turnos.t3.inicioMs),
    estado: "relevo_no_llego", entradaMs: store.turnos.t3.inicioMs, salidaMs: null, retardo: false, falta: false, minutosExtra: 45, extraEstado: "pendiente", extraEnCurso: true, relevoAlerta: true, relevoRequerido: true, relevoLlegado: false, fotoEntrada: true, ajustes: 0 },
};

// ---- API mínima compatible con lo que importan las vistas ----
export const initializeApp = () => ({});
export const getFirestore = () => ({ __db: true });
export const collection = (_db, name) => ({ __col: name });
export const doc = (_db, col, id) => ({ __doc: [col, id] });
export const where = (campo, op, valor) => ({ k: "where", campo, op, valor });
export const orderBy = (campo, dir = "asc") => ({ k: "order", campo, dir });
export const limit = (n) => ({ k: "limit", n });
export const query = (col, ...cs) => ({ ...col, cs });
const snapDoc = (id, data) => ({ id, data: () => data, exists: () => Boolean(data) });

export async function getDoc(r) {
  const [c, id] = r.__doc;
  if (ROL === "guardia" && c === "sitios" && !(store.usuarios[UID].sitiosAsignados || []).includes(id))
    throw Object.assign(new Error("permiso"), { code: "permission-denied" });
  return snapDoc(id, store[c]?.[id]);
}

export async function getDocs(q) {
  let docs = Object.entries(store[q.__col] || {}).map(([id, d]) => ({ id, d }));
  for (const c of q.cs || []) {
    if (c.k === "where") docs = docs.filter(({ d }) => ({ "==": d[c.campo] === c.valor, ">=": d[c.campo] >= c.valor, "<": d[c.campo] < c.valor })[c.op]);
  }
  for (const c of q.cs || []) if (c.k === "order") docs.sort((a, b) => (a.d[c.campo] - b.d[c.campo]) * (c.dir === "desc" ? -1 : 1) || 0);
  const lim = (q.cs || []).find((c) => c.k === "limit");
  if (lim) docs = docs.slice(0, lim.n);
  return { docs: docs.map(({ id, d }) => snapDoc(id, d)), empty: docs.length === 0 };
}

// ---- Auth falsa: ya con sesión según ?rol= ----
const user = { uid: UID, getIdToken: async () => "fake-token", getIdTokenResult: async () => ({ claims: { rol: ROL } }) };
let cb = null;
const auth = { currentUser: user };
export const initializeAuth = () => auth;
export const indexedDBLocalPersistence = {};
export const browserLocalPersistence = {};
export const onAuthStateChanged = (_a, f) => { cb = f; setTimeout(() => f(p.get("anon") ? null : user), 50); return () => {}; };
export const signOut = async () => { auth.currentUser = null; if (cb) cb(null); };
export const signInWithCustomToken = async () => {};
export const signInWithEmailAndPassword = async () => {};
