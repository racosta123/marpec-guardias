// Entorno de pruebas: Google simulado en memoria (OAuth, JWKS, Firestore REST, Identity Toolkit)
// y un namespace de Durable Objects en memoria que usa la clase RateLimiter real.
import { b64u, signJwt } from "../src/crypto.js";
import { RateLimiter } from "../src/ratelimit.js";
import { resetCaches } from "../src/google.js";

export const PROJECT = "marpec-test";
export const ORIGIN = "https://racosta123.github.io";

function toPem(der) {
  const b = Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b}\n-----END PRIVATE KEY-----\n`;
}

async function genKey() {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
}

export async function createWorld() {
  const sa = await genKey(); // cuenta de servicio
  const st = await genKey(); // firma de ID tokens (securetoken)
  const saPem = toPem(await crypto.subtle.exportKey("pkcs8", sa.privateKey));
  const stJwk = { ...(await crypto.subtle.exportKey("jwk", st.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

  const docs = new Map(); // path -> fields (formato Firestore)
  const authUsers = new Map(); // uid -> {email, customAttributes}
  const world = { docs, authUsers, calls: [] };

  // Durable Objects en memoria
  const stores = new Map();
  const RATE_LIMITER = {
    idFromName: (n) => n,
    get: (id) => {
      if (!stores.has(id)) {
        const m = new Map();
        const state = { storage: { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) } };
        stores.set(id, new RateLimiter(state));
      }
      const obj = stores.get(id);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    },
  };

  const env = {
    FIREBASE_PROJECT_ID: PROJECT,
    ALLOWED_ORIGIN: ORIGIN,
    PIN_PEPPER: "pimienta-de-prueba-aleatoria-0123456789abcdef",
    SETUP_TOKEN: "setup-token-de-prueba",
    QR_SECRET: "secreto-qr-de-prueba-0123456789abcdef0123456789",
    SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "sa@marpec-test.iam.gserviceaccount.com", private_key: saPem }),
    RATE_LIMITER,
    // R2 simulado en memoria
    SELFIES: {
      objetos: new Map(),
      async put(k, v, o) { this.objetos.set(k, { bytes: new Uint8Array(v), o }); },
      async get(k) { const x = this.objetos.get(k); return x ? { body: new Response(x.bytes).body, httpMetadata: x.o?.httpMetadata } : null; },
      async delete(k) { this.objetos.delete(k); },
    },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const u = new URL(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    world.calls.push(`${init.method || "GET"} ${u.host}${u.pathname}`);

    if (u.host === "oauth2.googleapis.com") return json({ access_token: "at-test", expires_in: 3600 });
    if (u.host === "www.googleapis.com") return json({ keys: [stJwk] });

    if (u.host === "firestore.googleapis.com") {
      const prefix = `/v1/projects/${PROJECT}/databases/(default)/documents`;
      if (u.pathname.endsWith(":commit")) {
        const { writes } = JSON.parse(init.body);
        world.commits = (world.commits || 0) + 1;
        for (const w of writes) {
          if (w.currentDocument?.exists === false && docs.has(w.update.name)) return json({ error: { status: "ALREADY_EXISTS" } }, 409);
          if (w.currentDocument?.exists === true && !docs.has(w.update.name)) return json({ error: { status: "NOT_FOUND" } }, 404);
        }
        for (const w of writes) {
          let fields = w.update.fields || {};
          if (w.updateMask) {
            const prev = { ...(docs.get(w.update.name) || {}) };
            for (const f of w.updateMask.fieldPaths) prev[f] = fields[f];
            fields = prev;
          }
          fields = { ...fields };
          for (const t of w.updateTransforms || []) fields[t.fieldPath] = { timestampValue: new Date(Date.now()).toISOString() };
          docs.set(w.update.name, fields);
        }
        return json({});
      }
      if (u.pathname.endsWith(":runQuery")) {
        const { structuredQuery: q } = JSON.parse(init.body);
        const filtros = !q.where ? [] : q.where.compositeFilter ? q.where.compositeFilter.filters : [q.where];
        const val = (f) => (f === undefined ? undefined : "integerValue" in f ? Number(f.integerValue) : "stringValue" in f ? f.stringValue : "nullValue" in f ? null : "booleanValue" in f ? f.booleanValue : f.doubleValue);
        const col = q.from[0].collectionId;
        const out = [];
        for (const [name, fields] of docs) {
          const rel = name.slice(name.indexOf("/documents/") + 11).split("/");
          if (rel.length !== 2 || rel[0] !== col) continue;
          const ok = filtros.every(({ fieldFilter: ff }) => {
            const x = val(fields[ff.field.fieldPath]); const y = val(ff.value);
            return ff.op === "EQUAL" ? x === y : ff.op === "GREATER_THAN_OR_EQUAL" ? x >= y : ff.op === "LESS_THAN" ? x < y : false;
          });
          if (ok) out.push({ document: { name, fields } });
        }
        return json(out.length ? out : [{ readTime: "x" }]);
      }
      const name = decodeURIComponent(u.pathname.slice(4)); // quita /v1/
      if ((init.method || "GET") === "DELETE") { docs.delete(name); return json({}); }
      if (!name.startsWith(prefix.slice(4))) return json({}, 404);
      return docs.has(name) ? json({ name, fields: docs.get(name) }) : json({}, 404);
    }

    if (u.host === "identitytoolkit.googleapis.com") {
      if (u.pathname.endsWith("/accounts:delete")) {
        authUsers.delete(JSON.parse(init.body).localId);
        return json({});
      }
      const b = JSON.parse(init.body);
      if (u.pathname.endsWith("/accounts:update")) {
        // Igual que Google: la creación NO guarda customAttributes; solo la actualización.
        const au = authUsers.get(b.localId);
        if (!au) return json({ error: { message: "USER_NOT_FOUND" } }, 400);
        const { localId, ...resto } = b;
        if (resto.email && [...authUsers.entries()].some(([k, x]) => k !== localId && x.email === resto.email))
          return json({ error: { message: "EMAIL_EXISTS" } }, 400);
        Object.assign(au, resto);
        return json({ localId: b.localId });
      }
      if ([...authUsers.values()].some((x) => x.email === b.email))
        return json({ error: { message: "EMAIL_EXISTS" } }, 400);
      const uid = `auth-${authUsers.size + 1}`;
      authUsers.set(uid, { email: b.email, customAttributes: undefined });
      return json({ localId: uid });
    }
    return realFetch(input, init);
  };

  resetCaches();
  world.restore = () => { globalThis.fetch = realFetch; };
  world.env = env;
  world.saPublic = sa.publicKey;

  // Emite un "ID token" como lo haría securetoken.google.com.
  world.idToken = async (uid, rol, over = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const { __key, ...rest } = over;
    const payload = {
      iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, iat: now - 5,
      exp: now + 3600, auth_time: now - 5, ...(rol ? { rol } : {}), ...rest,
    };
    return signJwt(payload, __key || st.privateKey, { kid: "k1" });
  };
  world.otherKey = (await genKey()).privateKey;
  return world;
}

export const call = (worker, env, method, path, { body, headers = {}, origin = ORIGIN, ip = "1.1.1.1" } = {}) =>
  worker.fetch(
    new Request(`https://proxy.example${path}`, {
      method,
      headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(origin ? { origin } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

export { b64u };

// Valor Firestore -> string simple
export const sv = (f) => f?.stringValue;
