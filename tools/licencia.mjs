// Licencia de demostración (config/licencia). ÚNICA vía de escritura, además del Worker: ningún rol de la app puede modificarla
// (las reglas de Firestore niegan toda escritura de clientes). Usa tu sesión de gcloud (propietario del proyecto).
// Fechas en hora de Hermosillo (UTC-7 todo el año); la demo vence AL FINAL de la fecha de vencimiento (23:59:59.999).
//
// Uso:
//   node tools/licencia.mjs estado
//   node tools/licencia.mjs iniciar [--dias 30] [--desde AAAA-MM-DD]   demo de N días: vence al final del día (desde + N); "desde" = hoy
//   node tools/licencia.mjs extender --dias N | --hasta AAAA-MM-DD     mueve la fecha de vencimiento (y lo deja en modo demo)
//   node tools/licencia.mjs produccion                                 sin vencimiento (los datos y la configuración no cambian)
import { execSync } from "node:child_process";

const P = "marpec-guardias";
const URL = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents/config/licencia`;
const [, , cmd, ...resto] = process.argv;
const opt = (n) => { const i = resto.indexOf(`--${n}`); return i >= 0 ? resto[i + 1] : undefined; };
const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const H = { authorization: `Bearer ${token}`, "x-goog-user-project": P, "content-type": "application/json" };

const HERMOSILLO_MS = -7 * 3600e3;
const dia = (ms) => new Date(ms + HERMOSILLO_MS).toISOString().slice(0, 10);
const inicioDelDia = (d) => Date.parse(`${d}T00:00:00.000-07:00`);
const finDelDia = (d) => Date.parse(`${d}T23:59:59.999-07:00`);
const sumarDias = (d, n) => dia(inicioDelDia(d) + n * 86400e3 + 12 * 3600e3);
const valida = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

async function leer() {
  const r = await fetch(URL, { headers: H });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`lectura: HTTP ${r.status}`);
  const f = (await r.json()).fields || {};
  return { modo: f.modo?.stringValue, inicio: f.inicio?.timestampValue, vence: f.vence?.timestampValue };
}
async function escribir({ modo, inicioMs, venceMs }) {
  const fields = { modo: { stringValue: modo }, inicio: { timestampValue: new Date(inicioMs).toISOString() }, vence: { timestampValue: new Date(venceMs).toISOString() } };
  const r = await fetch(URL, { method: "PATCH", headers: H, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`escritura: HTTP ${r.status} ${await r.text()}`);
}
function mostrar(l) {
  if (!l) return console.log("Licencia: NO EXISTE (sin licencia el servicio está cerrado). Crea una con: node tools/licencia.mjs iniciar");
  const ahora = Date.now();
  console.log(`Modo: ${l.modo}`);
  if (l.modo === "produccion") return console.log("Sin vencimiento.");
  const dias = Math.round((inicioDelDia(dia(Date.parse(l.vence) - 1)) - inicioDelDia(dia(ahora))) / 86400e3);
  console.log(`Inicio: ${dia(Date.parse(l.inicio))}   Vence: final del ${dia(Date.parse(l.vence) - 1)} (hora de Hermosillo)`);
  console.log(Date.parse(l.vence) <= ahora ? "ESTADO: VENCIDA" : `ESTADO: vigente (${dias === 0 ? "vence hoy" : `faltan ${dias} día(s)`})`);
}

const actual = await leer();
let nueva;
if (cmd === "estado") {
  mostrar(actual);
} else if (cmd === "iniciar") {
  const dias = Number(opt("dias") ?? 30);
  const desde = opt("desde") ?? dia(Date.now());
  if (!Number.isInteger(dias) || dias < 1 || !valida(desde)) throw new Error("uso: iniciar [--dias N] [--desde AAAA-MM-DD]");
  nueva = { modo: "demo", inicioMs: inicioDelDia(desde), venceMs: finDelDia(sumarDias(desde, dias)) };
} else if (cmd === "extender") {
  if (!actual) throw new Error("no hay licencia que extender; usa iniciar");
  const base = dia(Date.parse(actual.vence) - 1);
  const hasta = opt("hasta") ?? (opt("dias") ? sumarDias(base, Number(opt("dias"))) : null);
  if (!valida(hasta)) throw new Error("uso: extender --dias N | --hasta AAAA-MM-DD");
  nueva = { modo: "demo", inicioMs: Date.parse(actual.inicio), venceMs: finDelDia(hasta) };
} else if (cmd === "produccion") {
  nueva = { modo: "produccion", inicioMs: actual ? Date.parse(actual.inicio) : Date.now(), venceMs: Date.parse("2999-12-31T23:59:59.999Z") };
} else {
  console.log("Uso: node tools/licencia.mjs estado | iniciar [--dias 30] [--desde AAAA-MM-DD] | extender --dias N | --hasta AAAA-MM-DD | produccion");
  process.exitCode = 1;
}
if (nueva) {
  console.log("Antes:"); mostrar(actual);
  await escribir(nueva);
  console.log("\nDespués:"); mostrar(await leer());
  console.log("\n(El Worker guarda la licencia en caché hasta 30 s; las reglas de Firestore la leen al instante.)");
}
