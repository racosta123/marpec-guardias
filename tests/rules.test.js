// Pruebas de reglas de Firestore y Storage con el emulador oficial.
// Ejecutar con:  npm run test:rules   (requiere Java para los emuladores de Firebase)
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query } from "firebase/firestore";
import { ref, getBytes, uploadBytes } from "firebase/storage";

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-marpec",
    firestore: { rules: readFileSync("firebase/firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
    storage: { rules: readFileSync("firebase/storage.rules", "utf8"), host: "127.0.0.1", port: 9199 },
  });
});
after(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  // Datos sembrados saltando las reglas (como lo haría el Worker).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "usuarios/g-G001"), { nombre: "Gael", rol: "guardia", activo: true });
    await setDoc(doc(db, "usuarios/g-G002"), { nombre: "Gema", rol: "guardia", activo: true });
    await setDoc(doc(db, "usuarios/sup1"), { nombre: "Sara", rol: "supervisor", activo: true });
    await setDoc(doc(db, "usuarios/adm1"), { nombre: "Ana", rol: "admin", activo: true });
    await setDoc(doc(db, "credenciales/G001"), { hash: "x", salt: "y" });
    await setDoc(doc(db, "ajustes/sistema"), { adminCreado: true });
  });
});

const anon = () => env.unauthenticatedContext();
const guardia = (uid = "g-G001") => env.authenticatedContext(uid, { rol: "guardia" });
const sup = () => env.authenticatedContext("sup1", { rol: "supervisor" });
const adm = () => env.authenticatedContext("adm1", { rol: "admin" });
const sinRol = () => env.authenticatedContext("intruso"); // cuenta creada por auto-registro, sin claim

test("sin sesión: no lee ni escribe NADA en Firestore", async () => {
  const db = anon().firestore();
  for (const p of ["usuarios/g-G001", "credenciales/G001", "ajustes/sistema", "turnos/x"]) {
    await assertFails(getDoc(doc(db, p)));
    await assertFails(setDoc(doc(db, p), { a: 1 }));
    await assertFails(updateDoc(doc(db, p), { a: 1 }));
    await assertFails(deleteDoc(doc(db, p)));
  }
  await assertFails(getDocs(collection(db, "usuarios")));
});

test("sin sesión: no lee ni escribe en Storage", async () => {
  const st = anon().storage();
  await assertFails(getBytes(ref(st, "fotos/a.jpg")));
  await assertFails(uploadBytes(ref(st, "fotos/a.jpg"), new Uint8Array([1])));
});

test("guardia: lee su propio perfil", async () => {
  await assertSucceeds(getDoc(doc(guardia().firestore(), "usuarios/g-G001")));
});

test("guardia: NO lee el perfil de otro guardia, ni listas, ni credenciales", async () => {
  const db = guardia().firestore();
  await assertFails(getDoc(doc(db, "usuarios/g-G002")));
  await assertFails(getDoc(doc(db, "usuarios/sup1")));
  await assertFails(getDocs(collection(db, "usuarios")));
  await assertFails(getDocs(query(collection(db, "usuarios"))));
  await assertFails(getDoc(doc(db, "credenciales/G001")));
  await assertFails(getDoc(doc(db, "ajustes/sistema")));
});

test("guardia: NO puede asignarse otro rol ni modificar/crear/borrar nada", async () => {
  const db = guardia().firestore();
  await assertFails(updateDoc(doc(db, "usuarios/g-G001"), { rol: "admin" }));
  await assertFails(setDoc(doc(db, "usuarios/g-G001"), { nombre: "Gael", rol: "admin", activo: true }));
  await assertFails(setDoc(doc(db, "usuarios/g-G999"), { nombre: "X", rol: "guardia" }));
  await assertFails(deleteDoc(doc(db, "usuarios/g-G001")));
  await assertFails(setDoc(doc(db, "credenciales/G001"), { hash: "mio" }));
  await assertFails(setDoc(doc(db, "ajustes/sistema"), { adminCreado: false }));
});

test("guardia: nada en Storage", async () => {
  const st = guardia().storage();
  await assertFails(getBytes(ref(st, "fotos/a.jpg")));
  await assertFails(uploadBytes(ref(st, "fotos/a.jpg"), new Uint8Array([1])));
});

test("supervisor y admin: leen solo su propio perfil; no escriben", async () => {
  await assertSucceeds(getDoc(doc(sup().firestore(), "usuarios/sup1")));
  await assertFails(getDoc(doc(sup().firestore(), "usuarios/g-G001")));
  await assertFails(updateDoc(doc(sup().firestore(), "usuarios/sup1"), { rol: "admin" }));
  await assertSucceeds(getDoc(doc(adm().firestore(), "usuarios/adm1")));
  await assertFails(getDoc(doc(adm().firestore(), "usuarios/g-G001")));
  await assertFails(setDoc(doc(adm().firestore(), "usuarios/x"), { rol: "admin" }));
  await assertFails(getDoc(doc(adm().firestore(), "credenciales/G001")));
});

test("cuenta autenticada SIN claim de rol (auto-registro): sin acceso a nada", async () => {
  const db = sinRol().firestore();
  await assertFails(getDoc(doc(db, "usuarios/intruso")));
  await assertFails(setDoc(doc(db, "usuarios/intruso"), { rol: "admin" }));
  await assertFails(getBytes(ref(sinRol().storage(), "x")));
});

test("un rol inventado en el token no sirve", async () => {
  const db = env.authenticatedContext("u1", { rol: "superadmin" }).firestore();
  await assertFails(getDoc(doc(db, "usuarios/u1")));
});
