// Ubicación, cámara en vivo, lector de QR y captura de selfie. Todo ocurre en el dispositivo y SOLO
// cuando el guardia marca (nunca rastreo en segundo plano). La selfie sale únicamente de un cuadro del
// video en vivo (getUserMedia): no hay selector de archivos ni galería.
import { jsQR } from "./vendor/jsqr.js";

export const hayConexion = () => navigator.onLine !== false;

export function pedirUbicacion({ timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Este dispositivo no ofrece GPS."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, precisionM: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1
        ? "Permiso de ubicación denegado. Actívalo en los ajustes del navegador para poder marcar."
        : e.code === 3 ? "No se pudo obtener la ubicación a tiempo. Sal a cielo abierto e inténtalo de nuevo."
          : "No se pudo obtener la ubicación. Inténtalo de nuevo.")),
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    );
  });
}

export async function abrirCamara(facingMode) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador no permite usar la cámara.");
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    throw new Error(e.name === "NotAllowedError" || e.name === "SecurityError"
      ? "Permiso de cámara denegado. Actívalo en los ajustes del navegador para poder marcar."
      : e.name === "NotFoundError" || e.name === "OverconstrainedError" ? "No se encontró la cámara necesaria en este dispositivo."
        : "No se pudo abrir la cámara. Cierra otras apps que la estén usando e inténtalo de nuevo.");
  }
}

export function detener(stream) {
  for (const t of stream?.getTracks?.() || []) t.stop();
}

export async function mostrarEnVideo(video, stream) {
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute("playsinline", "");
  await video.play().catch(() => {});
}

// Escanea el video buscando un QR. Usa BarcodeDetector si existe; si no, jsQR sobre un canvas.
// Devuelve una función para detener el escaneo.
export function escanearQr(video, alDetectar) {
  let activo = true;
  let detector = null;
  try {
    if ("BarcodeDetector" in window) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
  } catch { detector = null; }
  const lienzo = document.createElement("canvas");
  const ctx = lienzo.getContext("2d", { willReadFrequently: true });

  async function ciclo() {
    if (!activo) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        let texto = null;
        if (detector) {
          const r = await detector.detect(video);
          if (r.length) texto = r[0].rawValue;
        } else {
          const esc = Math.min(1, 640 / video.videoWidth);
          lienzo.width = Math.round(video.videoWidth * esc);
          lienzo.height = Math.round(video.videoHeight * esc);
          ctx.drawImage(video, 0, 0, lienzo.width, lienzo.height);
          const img = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
          const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (r) texto = r.data;
        }
        if (texto) alDetectar(texto);
      }
    } catch { /* un cuadro fallido no detiene el escaneo */ }
    if (activo) setTimeout(ciclo, 200);
  }
  setTimeout(ciclo, 0); // no sincrónico: quien llama debe recibir primero la función para detener, aunque el QR ya esté a la vista
  return () => { activo = false; };
}

// Toma un cuadro del video EN VIVO y lo comprime a JPEG (≤ ~100 KB, ancho máx. 480 px).
export async function capturarSelfie(video, { maxBytes = 100 * 1024, maxAncho = 480 } = {}) {
  if (!video.videoWidth) throw new Error("La cámara aún no está lista.");
  let ancho = Math.min(maxAncho, video.videoWidth);
  for (let intento = 0; intento < 4; intento++) {
    const lienzo = document.createElement("canvas");
    lienzo.width = ancho;
    lienzo.height = Math.round((video.videoHeight * ancho) / video.videoWidth);
    lienzo.getContext("2d").drawImage(video, 0, 0, lienzo.width, lienzo.height);
    for (const calidad of [0.8, 0.7, 0.6, 0.5, 0.4]) {
      const blob = await new Promise((r) => lienzo.toBlob(r, "image/jpeg", calidad));
      if (blob && blob.size <= maxBytes) return { blob, base64: await aBase64(blob), url: URL.createObjectURL(blob) };
    }
    ancho = Math.round(ancho * 0.8);
  }
  throw new Error("No se pudo comprimir la foto. Inténtalo de nuevo.");
}

function aBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]);
    fr.onerror = () => rej(new Error("No se pudo leer la foto."));
    fr.readAsDataURL(blob);
  });
}

// Distancia (m) entre dos coordenadas; solo informativa para el guardia (el Worker decide).
export function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8, r = (g) => (g * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
