// Borra TODOS los usuarios de prueba (prueba=true) de Firestore y de Firebase Auth.
// La bitácora (auditoria/) es inmutable y NO se borra: sus entradas de prueba llevan prueba=true para filtrarlas.
// Úsalo antes de entregar a MARPEC. Usa tu sesión de gcloud (propietario del proyecto).
// Uso: node tools/borrar-pruebas.mjs [--aplicar]   (sin --aplicar solo muestra qué borraría)
import { execSync } from "node:child_process";

const P = "marpec-guardias";
const aplicar = process.argv.includes("--aplicar");
const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const H = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-goog-user-project": P };
const FS = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;
const IDTK = `https://identitytoolkit.googleapis.com/v1/projects/${P}`;

async function consulta(coleccion) {
  const r = await fetch(`${FS}:runQuery`, {
    method: "POST", headers: H,
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: coleccion }],
      where: { fieldFilter: { field: { fieldPath: "prueba" }, op: "EQUAL", value: { booleanValue: true } } } } }),
  });
  return (await r.json()).filter((x) => x.document).map((x) => x.document);
}

const usuarios = await consulta("usuarios");
const marcas = await consulta("marcas");
const credenciales = [...(await consulta("credenciales")), ...(await consulta("sitios")), ...(await consulta("turnos")), ...marcas,
  ...(await consulta("asistencias")), ...(await consulta("ajustesAsistencia")), ...(await consulta("autorizaciones"))];
const uids = usuarios.map((d) => d.name.split("/").pop());
console.log(`Usuarios de prueba: ${usuarios.length}, credenciales/sitios/turnos/marcas/asistencias/ajustes/autorizaciones de prueba: ${credenciales.length}`);
for (const d of usuarios) console.log(" -", d.fields.rol?.stringValue, d.fields.nombre?.stringValue);
if (!aplicar) { console.log("\n(simulación) Ejecuta con --aplicar para borrar."); process.exit(0); }

// Selfies de prueba en R2 (bucket privado)
let fotos = 0;
for (const m of marcas) {
  const k = m.fields.fotoKey?.stringValue;
  if (!k) continue;
  try { execSync(`wrangler r2 object delete marpec-guardias-selfies/${k} --remote`, { cwd: "worker", stdio: "pipe" }); fotos++; } catch { console.log(`  no se pudo borrar la foto ${k}`); }
}
console.log(`Selfies de prueba borradas de R2: ${fotos}`);
for (const d of [...usuarios, ...credenciales]) await fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: "DELETE", headers: H });
let authBorrados = 0;
for (const uid of uids) {
  const r = await fetch(`${IDTK}/accounts:delete`, { method: "POST", headers: H, body: JSON.stringify({ localId: uid }) });
  if (r.ok) authBorrados++;
}
console.log(`Borrados: ${usuarios.length + credenciales.length} documentos y ${authBorrados} cuentas de Auth.`);
