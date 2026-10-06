// Reglas de la licencia de demostración con el emulador oficial.
// Ejecutar con:  npm run test:rules   (requiere Java). Usa su propio projectId para no chocar con las demás pruebas.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, onSnapshot, Timestamp } from "firebase/firestore";

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-marpec-lic", firestore: { rules: readFileSync("firebase/firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
after(async () => env?.cleanup());

const lic = (d) => env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), "config/licencia"), d));
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const put = (p, d) => setDoc(doc(ctx.firestore(), p), d);
    await put("usuarios/adm1", { nombre: "Ana", rol: "admin", activo: true });
    await put("usuarios/sup1", { nombre: "Sara", rol: "supervisor", activo: true });
    await put("usuarios/g1", { nombre: "Gael", rol: "guardia", activo: true, sitiosAsignados: [] });
    await put("sitios/s1", { nombre: "Sitio", supervisorUid: "sup1" });
  });
});
const db = (uid, rol) => env.authenticatedContext(uid, { rol }).firestore();
const manana = () => Timestamp.fromMillis(Date.now() + 86400e3);
const ayer = () => Timestamp.fromMillis(Date.now() - 86400e3);

test("demo vigente: las lecturas permitidas por rol funcionan", async () => {
  await lic({ modo: "demo", inicio: ayer(), vence: manana() });
  await assertSucceeds(getDocs(collection(db("adm1", "admin"), "sitios")));
  await assertSucceeds(getDoc(doc(db("g1", "guardia"), "usuarios/g1")));
});

test("demo vencida: ninguna lectura (admin, supervisor ni guardia), ni get ni list", async () => {
  await lic({ modo: "demo", inicio: ayer(), vence: ayer() });
  await assertFails(getDocs(collection(db("adm1", "admin"), "sitios")));
  await assertFails(getDoc(doc(db("adm1", "admin"), "usuarios/adm1")));
  await assertFails(getDoc(doc(db("sup1", "supervisor"), "sitios/s1")));
  await assertFails(getDoc(doc(db("g1", "guardia"), "usuarios/g1")));
});

test("el listener en vivo se corta al vencer (permission-denied)", async () => {
  await lic({ modo: "demo", inicio: ayer(), vence: ayer() });
  const error = await new Promise((resolve) => {
    const baja = onSnapshot(collection(db("adm1", "admin"), "sitios"), () => resolve(null), (e) => { baja(); resolve(e); });
    setTimeout(() => { baja(); resolve("sin respuesta"); }, 8000);
  });
  assert.equal(error?.code, "permission-denied");
});

test("sin documento de licencia no se lee nada", async () => {
  await assertFails(getDocs(collection(db("adm1", "admin"), "sitios")));
});

test("modo producción: sin vencimiento aunque la fecha ya pasó", async () => {
  await lic({ modo: "produccion", inicio: ayer(), vence: ayer() });
  await assertSucceeds(getDocs(collection(db("adm1", "admin"), "sitios")));
});

test("NINGÚN rol puede leer ni modificar la licencia (ni el admin)", async () => {
  await lic({ modo: "demo", inicio: ayer(), vence: manana() });
  for (const [uid, rol] of [["adm1", "admin"], ["sup1", "supervisor"], ["g1", "guardia"]]) {
    const d = doc(db(uid, rol), "config/licencia");
    await assertFails(getDoc(d));
    await assertFails(setDoc(d, { modo: "produccion", vence: Timestamp.fromMillis(Date.now() + 1e12) }));
    await assertFails(updateDoc(d, { vence: Timestamp.fromMillis(Date.now() + 1e12) }));
    await assertFails(deleteDoc(d));
  }
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), "config/licencia"), { modo: "produccion" }));
});
