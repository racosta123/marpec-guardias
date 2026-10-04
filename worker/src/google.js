// Acceso a Google (OAuth con cuenta de servicio, Firestore REST, Identity Toolkit)
// y verificación de ID tokens de Firebase. Sin dependencias.
import { b64u, decodeJwtPart, b64uToBytes, importPrivateKey, signJwt } from "./crypto.js";

const DEFAULTS = {
  tokenUrl: "https://oauth2.googleapis.com/token",
  firestore: "https://firestore.googleapis.com/v1",
  idtk: "https://identitytoolkit.googleapis.com/v1",
  jwks: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
};
const cfg = (env) => ({
  tokenUrl: env.GOOGLE_TOKEN_URL || DEFAULTS.tokenUrl,
  firestore: env.FIRESTORE_URL || DEFAULTS.firestore,
  idtk: env.IDTK_URL || DEFAULTS.idtk,
  jwks: env.JWKS_URL || DEFAULTS.jwks,
});

export class HttpError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// ---- cuenta de servicio -------------------------------------------------
let saCache = null; // { raw, sa, key }
async function serviceAccount(env) {
  if (saCache && saCache.raw === env.SERVICE_ACCOUNT_JSON) return saCache;
  const sa = JSON.parse(env.SERVICE_ACCOUNT_JSON.replace(/^﻿/, "").trim());
  saCache = { raw: env.SERVICE_ACCOUNT_JSON, sa, key: await importPrivateKey(sa.private_key) };
  return saCache;
}

let tokCache = { token: null, exp: 0 };
export async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokCache.token && tokCache.exp - 60 > now) return tokCache.token;
  const { sa, key } = await serviceAccount(env);
  const assertion = await signJwt(
    {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: cfg(env).tokenUrl,
      iat: now,
      exp: now + 3600,
    },
    key,
  );
  const res = await fetch(cfg(env).tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new HttpError(502, "upstream_auth");
  const j = await res.json();
  tokCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokCache.token;
}

export function resetCaches() {
  saCache = null;
  tokCache = { token: null, exp: 0 };
  jwksCache = { keys: null, exp: 0 };
}

// ---- Custom token de Firebase ------------------------------------------
export async function mintCustomToken(env, uid, claims) {
  const { sa, key } = await serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      iat: now,
      exp: now + 300,
      uid,
      claims,
    },
    key,
  );
}

// ---- Firestore (REST) ---------------------------------------------------
export function enc(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === "number" && Number.isFinite(v)) return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  throw new Error("tipo no soportado");
}
export function dec(f) {
  if ("stringValue" in f) return f.stringValue;
  if ("booleanValue" in f) return f.booleanValue;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("doubleValue" in f) return f.doubleValue;
  if ("timestampValue" in f) return f.timestampValue;
  if ("nullValue" in f) return null;
  if ("arrayValue" in f) return (f.arrayValue.values || []).map(dec);
  return undefined;
}
const toFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const fromFields = (fields = {}) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, dec(v)]));

const base = (env) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

export async function getDocument(env, path) {
  const token = await accessToken(env);
  const res = await fetch(`${cfg(env).firestore}/${base(env)}/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, "upstream_firestore");
  return fromFields((await res.json()).fields);
}

// writes: [{ path, data, mustNotExist?, mustExist?, merge?, serverTimeField?, serverTimeFields? }]
// Todo en una sola transacción atómica. `merge` actualiza SOLO los campos de `data` (updateMask).
export async function commit(env, writes) {
  const token = await accessToken(env);
  const body = {
    writes: writes.map((w) => {
      const out = {
        update: { name: `${base(env)}/${w.path}`, fields: toFields(w.data) },
      };
      if (w.merge) out.updateMask = { fieldPaths: Object.keys(w.data) };
      if (w.mustNotExist) out.currentDocument = { exists: false };
      if (w.mustExist) out.currentDocument = { exists: true };
      const stf = [...(w.serverTimeField ? [w.serverTimeField] : []), ...(w.serverTimeFields || [])];
      if (stf.length)
        out.updateTransforms = stf.map((f) => ({ fieldPath: f, setToServerValue: "REQUEST_TIME" }));
      return out;
    }),
  };
  const res = await fetch(`${cfg(env).firestore}/${base(env)}:commit`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new HttpError(404, "not_found");
  if (res.status === 409 || res.status === 400) {
    const j = await res.json().catch(() => ({}));
    const st = j?.error?.status;
    if (st === "ALREADY_EXISTS" || st === "FAILED_PRECONDITION" || res.status === 409)
      throw new HttpError(409, "exists");
    if (st === "NOT_FOUND") throw new HttpError(404, "not_found");
    throw new HttpError(502, "upstream_firestore");
  }
  if (!res.ok) throw new HttpError(502, "upstream_firestore");
}

// filtros: [{ campo, op: "EQUAL"|"GREATER_THAN_OR_EQUAL"|"LESS_THAN", valor }]. Devuelve [{ id, ...campos }].
export async function runQuery(env, coleccion, filtros = [], { limite = 1000 } = {}) {
  const token = await accessToken(env);
  const fieldFilters = filtros.map((f) => ({
    fieldFilter: { field: { fieldPath: f.campo }, op: f.op, value: enc(f.valor) },
  }));
  const structuredQuery = { from: [{ collectionId: coleccion }], limit: limite };
  if (fieldFilters.length === 1) structuredQuery.where = fieldFilters[0];
  else if (fieldFilters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters: fieldFilters } };
  const res = await fetch(`${cfg(env).firestore}/${base(env)}:runQuery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new HttpError(502, "upstream_firestore");
  return (await res.json())
    .filter((r) => r.document)
    .map((r) => ({ id: r.document.name.split("/").pop(), ...fromFields(r.document.fields) }));
}

export async function deleteDocument(env, path) {
  const token = await accessToken(env);
  await fetch(`${cfg(env).firestore}/${base(env)}/${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

// ---- Identity Toolkit (admin) -------------------------------------------
export async function createAuthUser(env, { email, password, displayName, claims }) {
  const token = await accessToken(env);
  const res = await fetch(`${cfg(env).idtk}/projects/${env.FIREBASE_PROJECT_ID}/accounts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      displayName,
      emailVerified: true,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (String(j?.error?.message || "").includes("EMAIL_EXISTS")) throw new HttpError(409, "exists");
    throw new HttpError(502, "upstream_identity");
  }
  // La creación ignora customAttributes: los claims se asignan con una actualización explícita.
  const up = await fetch(`${cfg(env).idtk}/projects/${env.FIREBASE_PROJECT_ID}/accounts:update`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ localId: j.localId, customAttributes: JSON.stringify(claims) }),
  });
  if (!up.ok) {
    await deleteAuthUser(env, j.localId).catch(() => {});
    throw new HttpError(502, "upstream_identity");
  }
  return j.localId;
}

// Inhabilita/habilita la cuenta y REVOCA los refresh tokens (validSince = ahora).
// Si la cuenta aún no existe en Auth (guardia que nunca entró) no hay nada que revocar.
export async function setAuthUserState(env, uid, { disabled }) {
  const token = await accessToken(env);
  const body = { localId: uid, disableUser: disabled };
  if (disabled) body.validSince = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${cfg(env).idtk}/projects/${env.FIREBASE_PROJECT_ID}/accounts:update`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { existia: true };
  const j = await res.json().catch(() => ({}));
  if (String(j?.error?.message || "").includes("USER_NOT_FOUND")) return { existia: false };
  throw new HttpError(502, "upstream_identity");
}

export async function updateAuthUser(env, uid, campos) {
  const token = await accessToken(env);
  const res = await fetch(`${cfg(env).idtk}/projects/${env.FIREBASE_PROJECT_ID}/accounts:update`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ localId: uid, ...campos }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    if (String(j?.error?.message || "").includes("EMAIL_EXISTS")) throw new HttpError(409, "exists");
    throw new HttpError(502, "upstream_identity");
  }
}

export async function deleteAuthUser(env, uid) {
  const token = await accessToken(env);
  await fetch(`${cfg(env).idtk}/projects/${env.FIREBASE_PROJECT_ID}/accounts:delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ localId: uid }),
  });
}

// ---- Verificación de ID tokens de Firebase -------------------------------
let jwksCache = { keys: null, exp: 0 };
async function getJwks(env) {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.exp > now) return jwksCache.keys;
  const res = await fetch(cfg(env).jwks);
  if (!res.ok) throw new HttpError(502, "upstream_jwks");
  const j = await res.json();
  jwksCache = { keys: j.keys, exp: now + 3600_000 };
  return j.keys;
}

export async function verifyIdToken(env, token) {
  const bad = () => new HttpError(401, "unauthorized");
  if (typeof token !== "string" || token.length > 4096) throw bad();
  const parts = token.split(".");
  if (parts.length !== 3) throw bad();
  let header, payload;
  try {
    header = decodeJwtPart(parts[0]);
    payload = decodeJwtPart(parts[1]);
  } catch {
    throw bad();
  }
  if (header.alg !== "RS256" || !header.kid) throw bad();

  const keys = await getJwks(env);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw bad();
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64uToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw bad();

  const now = Math.floor(Date.now() / 1000);
  const pid = env.FIREBASE_PROJECT_ID;
  if (payload.aud !== pid || payload.iss !== `https://securetoken.google.com/${pid}`) throw bad();
  if (typeof payload.exp !== "number" || payload.exp <= now) throw bad();
  if (typeof payload.iat !== "number" || payload.iat > now + 60) throw bad();
  if (typeof payload.sub !== "string" || !payload.sub) throw bad();
  return payload;
}

export { b64u };
