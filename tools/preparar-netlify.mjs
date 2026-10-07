// Copia LIMPIA del frontend para publicarla en Netlify: sin historial de git, sin worker/tests/herramientas/respaldos y sin
// rastro del repositorio de GitHub. Solo archivos estáticos públicos (la seguridad está en el Worker y en las reglas de Firestore).
// Uso: node tools/preparar-netlify.mjs <origen https://sitio.netlify.app> [carpeta-salida]   (por omisión ../marpec-netlify)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const origen = process.argv[2];
if (!/^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origen || "")) throw new Error("uso: node tools/preparar-netlify.mjs https://<nombre>.netlify.app [carpeta-salida]");
const salida = resolve(process.argv[3] || "../marpec-netlify");
if (existsSync(join(salida, ".git"))) throw new Error("la carpeta de salida ya tiene .git: usa una carpeta limpia");
rmSync(salida, { recursive: true, force: true });
mkdirSync(salida, { recursive: true });

// Solo el frontend estático.
const ARCHIVOS = ["index.html", "privacidad.html", "aviso-visitantes.html", "qr.html", "punto-qr.html", "manifest.webmanifest", "marpec-logo.png", "sw.js"];
const CARPETAS = ["css", "js", "fonts", "icons"];
for (const a of ARCHIVOS) cpSync(a, join(salida, a));
for (const c of CARPETAS) cpSync(c, join(salida, c), { recursive: true });

// 1) El origen exacto de Netlify entra a la política de seguridad de cada página (connect-src) y se retiran referencias a GitHub Pages.
for (const p of ["index.html", "qr.html", "punto-qr.html"]) {
  const f = join(salida, p);
  let h = readFileSync(f, "utf8");
  const antes = h;
  h = h.replace(/connect-src 'self'/, `connect-src 'self' ${origen}`);
  if (h === antes) throw new Error(`${p}: no se encontró connect-src 'self' en la política de seguridad`);
  writeFileSync(f, h);
}
// 2) La PWA vive en la raíz del sitio de Netlify.
const mf = join(salida, "manifest.webmanifest");
writeFileSync(mf, readFileSync(mf, "utf8").replace('"id": "/marpec-guardias/"', '"id": "/"'));

// 3) Encabezados de seguridad equivalentes a los del Worker (GitHub Pages solo permitía meta; Netlify sí permite encabezados).
const worker = /workerUrl:\s*"([^"]+)"/.exec(readFileSync(join(salida, "js/config.js"), "utf8"))[1];
const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self'; connect-src 'self' ${origen} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com ${worker}; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'`;
writeFileSync(join(salida, "_headers"), `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  Permissions-Policy: geolocation=(self), camera=(self), microphone=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin

/sw.js
  Cache-Control: no-cache
  Service-Worker-Allowed: /

/index.html
  Cache-Control: no-cache

/manifest.webmanifest
  Content-Type: application/manifest+json
  Cache-Control: no-cache

/js/*
  Cache-Control: no-cache

/css/*
  Cache-Control: no-cache

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/icons/*
  Cache-Control: public, max-age=604800
`);

// 4) Revisión de la copia: nada de git, de GitHub ni de secretos.
// (Los créditos de licencias de librerías de terceros mencionan github.com: no son rastro del repositorio del proyecto.)
const prohibido = [/racosta123/i, /[a-z0-9-]+\.github\.io/i, /BEGIN [A-Z ]*PRIVATE KEY/, /service[_-]?account/i, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/];
const hallazgos = [];
(function recorrer(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (n === ".git" || n === "node_modules" || n === ".netlify" || /^\.env/.test(n)) hallazgos.push(`${p}: archivo o carpeta prohibido`);
    else if (statSync(p).isDirectory()) recorrer(p);
    else if (/\.(html|js|css|webmanifest|txt|json|md)$|^_headers$/.test(n)) {
      const t = readFileSync(p, "utf8");
      for (const re of prohibido) if (re.test(t)) hallazgos.push(`${p}: coincide con ${re}`);
    }
  }
})(salida);
if (hallazgos.length) { console.error("HALLAZGOS:\n" + hallazgos.join("\n")); process.exit(1); }
console.log(`Copia limpia lista en ${salida}\nOrigen: ${origen} · Worker: ${worker}\nSin .git, sin referencias a GitHub y sin secretos.`);
