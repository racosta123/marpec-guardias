// Crea el PRIMER admin (un solo uso). Se ejecuta en TU terminal: la contraseña se escribe oculta
// y viaja directo al Worker; no pasa por el chat ni se guarda en disco.
// Uso:  node tools/primer-admin.mjs
import { readFileSync, rmSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const WORKER = "https://marpec-guardias-proxy.acosta4770.workers.dev";
const TOKEN_FILE = ".tools/setup-token.txt";

if (!existsSync(TOKEN_FILE)) {
  console.error("No encuentro el token de setup (.tools/setup-token.txt). Pide que se regenere.");
  process.exit(1);
}
const token = readFileSync(TOKEN_FILE, "utf8").trim();

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

function askHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const buf = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf.join(""));
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f" || c === "\b") buf.pop();
        else buf.push(c);
      }
    };
    process.stdin.on("data", onData);
  });
}

const nombre = (await ask("Nombre completo del admin: ")).trim();
const email = (await ask("Correo del admin: ")).trim();
rl.close();
const password = await askHidden("Contraseña (mínimo 10 caracteres, no se muestra): ");
const confirma = await askHidden("Repite la contraseña: ");
if (password !== confirma) {
  console.error("Las contraseñas no coinciden. No se creó nada.");
  process.exit(1);
}

const res = await fetch(`${WORKER}/setup/primer-admin`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-setup-token": token },
  body: JSON.stringify({ nombre, email, password }),
});
const out = await res.json().catch(() => ({}));
if (res.status === 201) {
  rmSync(TOKEN_FILE, { force: true });
  console.log("✔ Admin creado. Token de setup local borrado. Avísale a Claude para que lo deshabilite en el Worker y lo verifique.");
} else {
  console.error(`✖ No se creó (HTTP ${res.status}): ${out.mensaje || out.error || "error"}`);
  process.exit(1);
}
