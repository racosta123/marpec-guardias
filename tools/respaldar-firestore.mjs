// Respaldo COMPLETO de Firestore (todas las colecciones, recursivo) a un JSON local con fecha.
// Solo lectura. Usa tu sesión de gcloud. Salida: .tools/respaldos/firestore-<fecha>.json (ignorado por git).
// Uso: node tools/respaldar-firestore.mjs
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";

const P = "marpec-guardias";
const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const H = { authorization: `Bearer ${token}`, "x-goog-user-project": P, "content-type": "application/json" };
const ROOT = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function listarColecciones(padre) {
  const ids = [];
  let pageToken;
  do {
    const j = await post(`${padre}:listCollectionIds`, { pageSize: 100, pageToken });
    ids.push(...(j.collectionIds || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return ids;
}

async function volcar(padre, id, salida) {
  let pageToken;
  do {
    const q = new URLSearchParams({ pageSize: "300", ...(pageToken ? { pageToken } : {}) });
    const r = await fetch(`${padre}/${id}?${q}`, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${id}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      salida.push({ ruta: d.name.split("/documents/")[1], campos: d.fields || {}, creado: d.createTime, actualizado: d.updateTime });
      const urlDoc = `https://firestore.googleapis.com/v1/${d.name}`;
      for (const sub of await listarColecciones(urlDoc)) await volcar(urlDoc, sub, salida);
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
}

const docs = [];
const colecciones = await listarColecciones(ROOT);
for (const c of colecciones) await volcar(ROOT, c, docs);

const ahora = new Date();
const marca = ahora.toISOString().replace(/[:.]/g, "-");
mkdirSync(".tools/respaldos", { recursive: true });
const archivo = `.tools/respaldos/firestore-${marca}.json`;
const porColeccion = {};
for (const d of docs) { const c = d.ruta.split("/")[0]; porColeccion[c] = (porColeccion[c] || 0) + 1; }
writeFileSync(archivo, JSON.stringify({ proyecto: P, fecha: ahora.toISOString(), colecciones, total: docs.length, porColeccion, documentos: docs }, null, 2));
console.log(`Respaldo: ${archivo}\nTamaño: ${statSync(archivo).size} bytes\nDocumentos: ${docs.length}`, porColeccion);
