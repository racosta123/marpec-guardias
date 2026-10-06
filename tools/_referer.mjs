// La clave web de Firebase está restringida por Referer (solo https://marpec-guardias.netlify.app/* y la ruta de MARPEC en GitHub Pages).
// Las herramientas que corren en Node (sin navegador) no envían Referer: se importa este archivo PRIMERO para que sus llamadas a
// Google (Identity Toolkit, Secure Token, Firestore) se identifiquen como la app. Es solo para uso del operador, no es un secreto.
const orig = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (/^https:\/\/[a-z0-9.-]*googleapis\.com\//.test(url)) {
    const h = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    if (!h.has("referer")) h.set("referer", "https://marpec-guardias.netlify.app/");
    init = { ...init, headers: h };
  }
  return orig(input, init);
};
