// Busca secretos en el árbol de trabajo y en TODO el historial de git. Sale con código 1 si encuentra algo.
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PATRONES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "llave privada PEM"],
  [/"private_key"\s*:/, "private_key de cuenta de servicio"],
  [/"type"\s*:\s*"service_account"/, "JSON de cuenta de servicio"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "token de GitHub"],
  [/github_pat_[A-Za-z0-9_]{30,}/, "token de GitHub"],
  [/AIza[0-9A-Za-z_-]{35}/, "API key de Google (verificar: la apiKey web es pública pero debe ser consciente)"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/, "token OAuth de Google"],
  [/\b1\/\/[0-9A-Za-z_-]{40,}/, "refresh token de Google"],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
  [/(CLOUDFLARE|CF)_API_TOKEN\s*[=:]\s*\S{20,}/, "token de Cloudflare"],
  [/(SETUP_TOKEN|PIN_PEPPER)\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{16,}/, "secret del Worker en claro"],
];
const SKIP_DIR = new Set(["node_modules", ".git", ".wrangler"]);
const SKIP_FILE = /\.(png|woff2|ico)$|(^|\/)package-lock\.json$|js\/vendor\/firebase\.js$|tools\/scan-secrets\.mjs$|worker\/test\/|js\/config\.js$/; // config.js: apiKey web pública por diseño
let hallazgos = 0;

function revisar(nombre, texto) {
  for (const [re, desc] of PATRONES) if (re.test(texto)) { console.log(`HALLAZGO ${desc}: ${nombre}`); hallazgos++; }
}

function recorrer(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) recorrer(p);
    else if (!SKIP_FILE.test(p.replaceAll("\\", "/"))) revisar(p, readFileSync(p, "utf8"));
  }
}
recorrer(".");

// Historial completo (todas las ramas). Vacío si aún no hay commits.
try {
  const commits = execSync("git rev-list --all", { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const c of commits) {
    const diff = execSync(`git show --format= --unified=0 ${c} -- . ":(exclude)worker/test" ":(exclude)tools/scan-secrets.mjs" ":(exclude)js/vendor" ":(exclude)js/config.js" ":(exclude)package-lock.json" ":(exclude)*.png" ":(exclude)*.woff2"`, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    revisar(`commit ${c.slice(0, 8)}`, diff);
  }
  console.log(`historial git revisado: ${commits.length} commit(s)`);
} catch {
  console.log("sin historial de git que revisar");
}
console.log(hallazgos ? `${hallazgos} hallazgo(s)` : "sin secretos detectados");
process.exit(hallazgos ? 1 : 0);
