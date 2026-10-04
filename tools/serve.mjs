// Servidor estático mínimo para desarrollo local (sin dependencias).
// Uso: node tools/serve.mjs [puerto] [--fake] [--base=/marpec-guardias]
//   --fake: sirve la interfaz contra un Firebase y un Worker SIMULADOS en el navegador (tests/ui),
//           sin CSP y con import map. Solo para revisar pantallas; nunca toca producción.
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(process.cwd());
const port = Number(process.argv.find((a) => /^\d+$/.test(a))) || 5173;
const fake = process.argv.includes("--fake");
// --base=/ruta simula la subruta de GitHub Pages (p. ej. --base=/marpec-guardias)
const base = (process.argv.find((a) => a.startsWith("--base=")) || "--base=").slice(7).replace(/\/$/, "");
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".json": "application/json",
};
const MAPA = '<script type="importmap">{"imports":{"/js/vendor/firebase.js":"/tests/ui/fake-firebase.js"}}</script>'
  + '<script type="module" src="/tests/ui/fake-worker.js"></script>';

createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (base) {
    if (u !== base && !u.startsWith(base + "/")) { res.writeHead(404); return res.end(); }
    u = u.slice(base.length) || "/";
  }
  if (u.endsWith("/")) u += "index.html";
  const fp = resolve(join(root, u));
  if (!fp.startsWith(root) || !existsSync(fp) || statSync(fp).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  const tipo = types[extname(fp)] || "application/octet-stream";
  if (fake && /(index|qr)\.html$/.test(fp)) {
    const html = readFileSync(fp, "utf8")
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
      .replace("</head>", `${MAPA}</head>`);
    res.writeHead(200, { "content-type": tipo });
    return res.end(html);
  }
  res.writeHead(200, { "content-type": tipo });
  createReadStream(fp).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}${fake ? " (modo simulado)" : ""}`));
