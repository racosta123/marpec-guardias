import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { b64uToBytes, decodeJwtPart } from "../src/crypto.js";
import { createWorld, call, ORIGIN, PROJECT, sv } from "./harness.js";

let w, env;
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

// Mundo nuevo (base, limitadores y llaves) para cada prueba.
beforeEach(async () => {
  if (w) w.restore();
  offset = 0;
  w = await createWorld();
  env = w.env;
});
after(() => { w.restore(); Date.now = realNow; });

// Crea un admin + un guardia directamente en la "base" simulada vía el propio Worker.
async function sembrarAdminYGuardia() {
  let r = await call(worker, env, "POST", "/setup/primer-admin", {
    headers: { "x-setup-token": env.SETUP_TOKEN },
    body: { nombre: "Ana Admin", email: "ana@marpec.mx", password: "una-clave-muy-larga-1" },
  });
  assert.equal(r.status, 201);
  const adminUid = (await r.json()).uid;
  const adminTok = await w.idToken(adminUid, "admin");
  r = await call(worker, env, "POST", "/admin/usuarios", {
    headers: { authorization: `Bearer ${adminTok}` },
    body: { rol: "guardia", nombre: "Gael Guardia", numeroEmpleado: "g001", pin: "4821" },
  });
  assert.equal(r.status, 201);
  return { adminUid, adminTok };
}

const login = (numero, pin, ip = "9.9.9.9") =>
  call(worker, env, "POST", "/auth/guardia", { body: { numero, pin }, ip });

test("el PIN se guarda con hash+sal, nunca en texto plano", async () => {
  await sembrarAdminYGuardia();
  const cred = w.docs.get(`projects/${PROJECT}/databases/(default)/documents/credenciales/G001`);
  assert.ok(cred, "existe credencial");
  const dump = JSON.stringify([...w.docs.entries()]);
  assert.ok(!dump.includes("4821"), "el PIN no aparece en ninguna parte");
  assert.ok(sv(cred.hash).length >= 40 && sv(cred.salt).length >= 20);
  assert.equal(Number(cred.iterations.integerValue), 100000);
});

test("login de guardia correcto emite custom token firmado con rol", async () => {
  await sembrarAdminYGuardia();
  const r = await login("G001", "4821");
  assert.equal(r.status, 200);
  const { token } = await r.json();
  const [h, p, s] = token.split(".");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", w.saPublic, b64uToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  assert.ok(ok, "firma válida con la cuenta de servicio");
  const pl = decodeJwtPart(p);
  assert.equal(pl.uid, "g-G001");
  assert.deepEqual(pl.claims, { rol: "guardia" });
  assert.ok(pl.exp - pl.iat <= 3600);
});

test("error genérico idéntico: número inexistente vs PIN incorrecto", async () => {
  await sembrarAdminYGuardia();
  const a = await login("G001", "0000", "2.2.2.2");
  const b = await login("NOEXISTE", "0000", "3.3.3.3");
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
});

test("bloqueo tras 5 intentos fallidos durante 15 min (incluso con PIN correcto)", async () => {
  await sembrarAdminYGuardia();
  for (let i = 0; i < 5; i++) {
    const r = await login("G001", "1111", `10.0.0.${i}`); // IPs distintas: el bloqueo es por empleado
    assert.equal(r.status, 401);
  }
  const bloqueado = await login("G001", "4821", "10.0.1.1");
  assert.equal(bloqueado.status, 401, "con PIN correcto sigue bloqueado");
  assert.deepEqual((await bloqueado.json()).error, "invalid_credentials");
  offset = 14 * 60 * 1000;
  assert.equal((await login("G001", "4821", "10.0.1.2")).status, 401, "a los 14 min sigue bloqueado");
  offset = 15 * 60 * 1000 + 1000;
  assert.equal((await login("G001", "4821", "10.0.1.3")).status, 200, "pasados 15 min vuelve a funcionar");
});

test("ALLOWED_ORIGIN admite varios orígenes EXACTOS (GitHub Pages y Netlify); ningún otro", async () => {
  env.ALLOWED_ORIGIN = `${ORIGIN}, https://marpec-guardias.netlify.app`;
  for (const o of [ORIGIN, "https://marpec-guardias.netlify.app"]) {
    const r = await call(worker, env, "GET", "/licencia/estado", { origin: o });
    assert.equal(r.status, 200, o);
    assert.equal(r.headers.get("access-control-allow-origin"), o);
    assert.equal((await call(worker, env, "OPTIONS", "/me", { origin: o })).status, 204);
  }
  for (const o of ["https://marpec-guardias.netlify.app.evil.com", "https://otro.netlify.app", "http://marpec-guardias.netlify.app", "https://netlify.app"]) {
    assert.equal((await call(worker, env, "GET", "/licencia/estado", { origin: o })).status, 403, o);
    assert.equal((await call(worker, env, "OPTIONS", "/me", { origin: o })).status, 403, o);
  }
});

test("un número inexistente también se bloquea (no revela existencia)", async () => {
  for (let i = 0; i < 5; i++) await login("FANTASMA", "1111", `11.0.0.${i}`);
  const r = await login("FANTASMA", "1111", "11.0.9.9");
  assert.equal(r.status, 401);
  assert.equal([...w.docs.keys()].filter((k) => !k.endsWith("/config/licencia")).length, 0); // no se creó nada (salvo la licencia sembrada)
});

test("límite por IP: 20 fallos desde una IP la bloquean para cualquier empleado", async () => {
  await sembrarAdminYGuardia();
  for (let i = 0; i < 20; i++) await login(`X${String(i).padStart(3, "0")}`, "1111", "7.7.7.7");
  const r = await login("G001", "4821", "7.7.7.7");
  assert.equal(r.status, 401, "IP bloqueada aunque el PIN sea correcto");
  const otra = await login("G001", "4821", "8.8.8.8");
  assert.equal(otra.status, 200, "otra IP no se ve afectada");
});

test("entrada malformada no revienta y cuenta como fallo", async () => {
  for (const body of [{}, { numero: 5, pin: 1 }, { numero: "a b", pin: "12" }, { numero: "G001", pin: "abcd" }]) {
    const r = await call(worker, env, "POST", "/auth/guardia", { body });
    assert.equal(r.status, 401);
  }
  const r = await worker.fetch(new Request("https://p/auth/guardia", { method: "POST", body: "{{{", headers: { origin: ORIGIN } }), env);
  assert.equal(r.status, 400);
});

test("CORS: solo el origen de GitHub Pages; otros reciben 403", async () => {
  const bad = await call(worker, env, "POST", "/auth/guardia", { origin: "https://evil.example", body: { numero: "G001", pin: "4821" } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const pre = await call(worker, env, "OPTIONS", "/auth/guardia", { origin: "https://evil.example" });
  assert.equal(pre.status, 403);
  const preOk = await call(worker, env, "OPTIONS", "/auth/guardia");
  assert.equal(preOk.status, 204);
  assert.equal(preOk.headers.get("access-control-allow-origin"), ORIGIN);
});

test("encabezados de seguridad presentes", async () => {
  const r = await call(worker, env, "GET", "/nada");
  assert.equal(r.status, 404);
  for (const h of ["strict-transport-security", "x-content-type-options", "content-security-policy", "cache-control", "referrer-policy"])
    assert.ok(r.headers.get(h), h);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("/me valida el ID token en cada petición", async () => {
  const { adminUid, adminTok } = await sembrarAdminYGuardia();
  const ok = await call(worker, env, "GET", "/me", { headers: { authorization: `Bearer ${adminTok}` } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { uid: adminUid, rol: "admin", nombre: "Ana Admin", numeroEmpleado: null });

  const casos = {
    "sin token": undefined,
    "basura": "Bearer abc.def.ghi",
    "firmado con otra llave": `Bearer ${await w.idToken(adminUid, "admin", { __key: w.otherKey })}`,
    "audiencia equivocada": `Bearer ${await w.idToken(adminUid, "admin", { aud: "otro-proyecto" })}`,
    "emisor equivocado": `Bearer ${await w.idToken(adminUid, "admin", { iss: "https://securetoken.google.com/otro" })}`,
    "expirado": `Bearer ${await w.idToken(adminUid, "admin", { exp: Math.floor(Date.now() / 1000) - 10 })}`,
    "alg none": `Bearer ${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: adminUid, aud: PROJECT })).toString("base64url")}.`,
  };
  for (const [nombre, h] of Object.entries(casos)) {
    const r = await call(worker, env, "GET", "/me", { headers: h ? { authorization: h } : {} });
    assert.equal(r.status, 401, nombre);
  }
});

test("el rol del token debe coincidir con el perfil (no se puede 'asignar' otro rol)", async () => {
  const { adminUid } = await sembrarAdminYGuardia();
  // Un token válido que dice rol=admin pero el perfil de g-G001 es guardia → 403
  const falso = await w.idToken("g-G001", "admin");
  assert.equal((await call(worker, env, "GET", "/me", { headers: { authorization: `Bearer ${falso}` } })).status, 403);
  // Token sin claim de rol → 403
  const sinRol = await w.idToken(adminUid, null);
  assert.equal((await call(worker, env, "GET", "/me", { headers: { authorization: `Bearer ${sinRol}` } })).status, 403);
});

test("un guardia no puede crear usuarios ni elevarse; un admin sí", async () => {
  await sembrarAdminYGuardia();
  const guardiaTok = await w.idToken("g-G001", "guardia");
  const r = await call(worker, env, "POST", "/admin/usuarios", {
    headers: { authorization: `Bearer ${guardiaTok}` },
    body: { rol: "supervisor", nombre: "Intruso", email: "x@x.mx", password: "una-clave-muy-larga-1" },
  });
  assert.equal(r.status, 403);
  assert.equal([...w.authUsers.values()].filter((u) => u.email === "x@x.mx").length, 0);
});

test("admin no puede crear otro admin por la API; supervisor recibe claim de supervisor", async () => {
  const { adminTok } = await sembrarAdminYGuardia();
  const h = { authorization: `Bearer ${adminTok}` };
  const a = await call(worker, env, "POST", "/admin/usuarios", { headers: h, body: { rol: "admin", nombre: "Otro", email: "o@m.mx", password: "una-clave-muy-larga-1" } });
  assert.equal(a.status, 400);
  const s = await call(worker, env, "POST", "/admin/usuarios", { headers: h, body: { rol: "supervisor", nombre: "Sara Sup", email: "sara@marpec.mx", password: "una-clave-muy-larga-1" } });
  assert.equal(s.status, 201);
  const u = [...w.authUsers.values()].find((x) => x.email === "sara@marpec.mx");
  assert.deepEqual(JSON.parse(u.customAttributes), { rol: "supervisor" });
});

test("usuarios de prueba quedan marcados con prueba=true", async () => {
  const { adminTok } = await sembrarAdminYGuardia();
  const h = { authorization: `Bearer ${adminTok}` };
  const r = await call(worker, env, "POST", "/admin/usuarios", { headers: h, body: { rol: "guardia", nombre: "Gina Prueba", numeroEmpleado: "T001", pin: "5937", prueba: true } });
  assert.equal(r.status, 201);
  const base = `projects/${PROJECT}/databases/(default)/documents`;
  assert.equal(w.docs.get(`${base}/usuarios/g-T001`).prueba.booleanValue, true);
  assert.equal(w.docs.get(`${base}/credenciales/T001`).prueba.booleanValue, true);
  assert.equal(w.docs.get(`${base}/usuarios/g-G001`).prueba, undefined);
});

test("primer admin: token incorrecto → 404; un solo uso; luego deshabilitado", async () => {
  const body = { nombre: "Ana Admin", email: "ana@marpec.mx", password: "una-clave-muy-larga-1" };
  const mal = await call(worker, env, "POST", "/setup/primer-admin", { headers: { "x-setup-token": "nope" }, body });
  assert.equal(mal.status, 404);
  assert.equal(w.authUsers.size, 0);
  const ok = await call(worker, env, "POST", "/setup/primer-admin", { headers: { "x-setup-token": env.SETUP_TOKEN }, body });
  assert.equal(ok.status, 201);
  assert.deepEqual(JSON.parse([...w.authUsers.values()][0].customAttributes), { rol: "admin" });
  const otra = await call(worker, env, "POST", "/setup/primer-admin", { headers: { "x-setup-token": env.SETUP_TOKEN }, body: { ...body, email: "otro@marpec.mx" } });
  assert.equal(otra.status, 404, "segunda vez deshabilitado");
  assert.equal(w.authUsers.size, 1);
});

test("primer admin: fuerza bruta del token de setup se bloquea", async () => {
  for (let i = 0; i < 5; i++)
    await call(worker, env, "POST", "/setup/primer-admin", { headers: { "x-setup-token": `mal${i}` }, body: {}, ip: "5.5.5.5" });
  const r = await call(worker, env, "POST", "/setup/primer-admin", {
    headers: { "x-setup-token": env.SETUP_TOKEN }, ip: "5.5.5.5",
    body: { nombre: "Ana Admin", email: "ana@marpec.mx", password: "una-clave-muy-larga-1" },
  });
  assert.equal(r.status, 404);
  assert.equal(w.authUsers.size, 0);
});

test("ningún secreto sale en respuestas ni en el perfil público", async () => {
  await sembrarAdminYGuardia();
  const r = await login("G001", "4821", "4.4.4.4");
  const txt = await r.text();
  assert.ok(!txt.includes(env.PIN_PEPPER) && !txt.includes("private_key"));
  const usuario = JSON.stringify(w.docs.get(`projects/${PROJECT}/databases/(default)/documents/usuarios/g-G001`));
  assert.ok(!/hash|salt|pin/i.test(usuario), "el perfil legible por el cliente no contiene credenciales");
});
