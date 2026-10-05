// Cola local (IndexedDB) para trabajar SIN INTERNET: los registros del guardia se guardan aquí con sus fotos y se
// envían solos al volver la conexión. También guarda el reloj (desfase conocido con el servidor) y copias de lo
// último que se vio en línea (turno, catálogo, rondín) para poder seguir trabajando sin señal.
//   · NUNCA se guarda el PIN ni un token: solo datos de los registros (que ya iban a viajar al Worker).
//   · Se borra TODO al cerrar sesión (vaciarTodo).
//   · El orden de envío es el de captura (cola FIFO); un registro rechazado por el servidor NO detiene a los demás.
const NOMBRE_DB = "marpec-cola";
let dbp = null;
const oyentes = new Set();
export const alCambiar = (f) => { oyentes.add(f); return () => oyentes.delete(f); };
const avisar = () => { for (const f of oyentes) { try { f(); } catch { /* un oyente no debe romper la cola */ } } };

function abrir() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(NOMBRE_DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("cola", { keyPath: "seq", autoIncrement: true });
      r.result.createObjectStore("meta");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error); };
  });
  return dbp;
}
const pedir = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
async function store(nombre, modo = "readonly") { const d = await abrir(); return d.transaction(nombre, modo).objectStore(nombre); }

// ---------------------------------------------------------------- meta (copias locales)
export async function metaGet(k) { try { return await pedir((await store("meta")).get(k)); } catch { return undefined; } }
export async function metaSet(k, v) { try { await pedir((await store("meta", "readwrite")).put(v, k)); } catch { /* sin IndexedDB: se trabaja solo en línea */ } }

// ---------------------------------------------------------------- reloj
// hora estimada = hora del dispositivo + desfase conocido (servidor − dispositivo en la última sincronización).
let desfaseMs = 0;
let ultimaSyncMs = null;
let guardadoMs = 0;
export function sincronizarReloj(servidorMs) {
  if (!Number.isFinite(servidorMs) || servidorMs < 1.5e12) return;
  desfaseMs = servidorMs - Date.now();
  ultimaSyncMs = Date.now();
  if (Date.now() - guardadoMs > 60000) { guardadoMs = Date.now(); metaSet("reloj", { desfaseMs, ultimaSyncMs }); }
}
export async function cargarReloj() {
  const r = await metaGet("reloj");
  if (r && Number.isFinite(r.desfaseMs) && ultimaSyncMs === null) { desfaseMs = r.desfaseMs; ultimaSyncMs = r.ultimaSyncMs; }
}
export const ahoraEstimado = () => Date.now() + desfaseMs;
export const relojInfo = () => ({ desfaseMs, ultimaSyncMs });

// ---------------------------------------------------------------- cola
export async function encolar(it) {
  const reg = { estado: "pendiente", intentos: 0, error: null, creadoMs: Date.now(), ...it };
  const seq = await pedir((await store("cola", "readwrite")).add(reg));
  avisar();
  return { ...reg, seq };
}
export async function listar() {
  try { return (await pedir((await store("cola")).getAll())).sort((a, b) => a.seq - b.seq); } catch { return []; }
}
export async function contarPendientes(uid) { return (await listar()).filter((x) => x.estado === "pendiente" && (!uid || x.uid === uid)).length; }
async function actualizar(seq, cambios) {
  const s = await store("cola", "readwrite");
  const actual = await pedir(s.get(seq));
  if (actual) await pedir(s.put({ ...actual, ...cambios }));
}
export async function descartar(seq) { await pedir((await store("cola", "readwrite")).delete(seq)); avisar(); }

// Cierre de sesión: se borra la cola, las copias y el reloj.
export async function vaciarTodo() {
  try {
    const d = await abrir();
    await new Promise((resolve, reject) => { const t = d.transaction(["cola", "meta"], "readwrite"); t.objectStore("cola").clear(); t.objectStore("meta").clear(); t.oncomplete = resolve; t.onerror = () => reject(t.error); });
  } catch { /* nada que borrar */ }
  desfaseMs = 0; ultimaSyncMs = null;
  avisar();
}

let enCurso = false;
// Envía en orden lo pendiente de ESTE usuario. Errores de red / 401 / 429 / 5xx: se detiene y se reintentará.
// Rechazo definitivo del servidor (4xx): el registro queda como «rechazado» con el motivo y se sigue con el resto.
export async function procesar(api, uid) {
  if (enCurso) return { ocupado: true };
  enCurso = true;
  let enviados = 0, rechazados = 0;
  try {
    for (const it of await listar()) {
      if (it.uid !== uid || it.estado !== "pendiente") continue;
      try {
        await api(it.ruta, { body: it.body });
        await pedir((await store("cola", "readwrite")).delete(it.seq));
        enviados++;
        avisar();
      } catch (e) {
        const st = e && e.status;
        if (!st || st === 401 || st === 429 || st >= 500) { await actualizar(it.seq, { intentos: (it.intentos || 0) + 1 }); return { enviados, rechazados, detenido: true }; }
        await actualizar(it.seq, { estado: "rechazado", error: String(e.message || "Rechazado").slice(0, 200), codigo: e.code || null });
        rechazados++;
        avisar();
      }
    }
    return { enviados, rechazados };
  } finally { enCurso = false; }
}
