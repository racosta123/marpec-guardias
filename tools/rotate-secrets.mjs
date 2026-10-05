// Carga/rota los secrets del Worker SIN pasar por el chat ni por el disco (salvo la llave de la
// cuenta de servicio, que existe en un archivo temporal solo unos segundos y se borra).
// Uso: node tools/rotate-secrets.mjs sa|pepper|setup|qr
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "marpec-guardias";
const SA = `marpec-worker@${PROJECT}.iam.gserviceaccount.com`;
const WORKER_DIR = "worker";
const sh = (cmd, args, input) =>
  spawnSync(cmd, args, { input, encoding: "utf8", shell: true, cwd: process.cwd() });

function putSecret(name, value) {
  const r = spawnSync("wrangler", ["secret", "put", name], { input: value, encoding: "utf8", shell: true, cwd: WORKER_DIR });
  console.log(r.status === 0 ? `ok: ${name}` : `FALLO ${name}: ${(r.stderr || r.stdout).slice(-200)}`);
  if (r.status !== 0) process.exit(1);
}

const what = process.argv[2];
// Fase 6: par de llaves VAPID (Web Push). Se genera aquí, se sube directo al Worker y NO se muestra ni se guarda en disco.
if (what === "vapid") {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  putSecret("VAPID_PRIVATE_JWK", JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }));
  console.log("Llaves VAPID generadas y cargadas como secret del Worker (no se muestran).");
} else if (what === "pepper") putSecret("PIN_PEPPER", randomBytes(48).toString("base64"));
else if (what === "qr") putSecret("QR_SECRET", randomBytes(48).toString("base64"));
else if (what === "setup") {
  const t = randomBytes(32).toString("hex");
  putSecret("SETUP_TOKEN", t);
  mkdirSync(".tools", { recursive: true });
  writeFileSync(".tools/setup-token.txt", t); // ignorado por git; se borra tras crear el admin
} else if (what === "sa") {
  const keyFile = join(tmpdir(), `mw-sa-${randomBytes(8).toString("hex")}.json`);
  try {
    const before = JSON.parse(sh("gcloud", ["iam", "service-accounts", "keys", "list", "--iam-account", SA, "--project", PROJECT, "--format=json"]).stdout || "[]")
      .filter((k) => k.keyType === "USER_MANAGED").map((k) => k.name.split("/").pop());
    const c = sh("gcloud", ["iam", "service-accounts", "keys", "create", `"${keyFile}"`, "--iam-account", SA, "--project", PROJECT]);
    if (!existsSync(keyFile)) { console.log("no se pudo crear la llave"); process.exit(1); }
    const json = readFileSync(keyFile, "utf8").replace(/^﻿/, "").trim();
    JSON.parse(json); // valida
    putSecret("SERVICE_ACCOUNT_JSON", json);
    for (const id of before) {
      sh("gcloud", ["iam", "service-accounts", "keys", "delete", id, "--iam-account", SA, "--project", PROJECT, "--quiet"]);
      console.log("llave anterior revocada");
    }
  } finally {
    rmSync(keyFile, { force: true });
    console.log(`archivo temporal borrado: ${!existsSync(keyFile)}`);
  }
} else console.log("uso: node tools/rotate-secrets.mjs sa|pepper|setup|qr|vapid");
