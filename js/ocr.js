// ocr.js — lazy-loads Tesseract.js (only when the user actually runs OCR) and
// returns recognized text. Requires network on first use to fetch the engine +
// language data; degrades gracefully with a clear message when offline.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

let loading = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.async = true;
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract failed to initialize')));
    s.onerror = () => reject(new Error('Could not download the OCR engine. Connect to the internet and try again (first use only).'));
    document.head.appendChild(s);
  });
  return loading;
}

export function ocrAvailable() {
  return navigator.onLine || !!window.Tesseract;
}

// file: a File/Blob (image). onProgress: (0..1) => void
export async function recognize(file, onProgress) {
  const Tesseract = await loadTesseract();
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
    },
  });
  try {
    const { data } = await worker.recognize(file);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}
