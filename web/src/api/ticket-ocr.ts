import { createWorker, OEM, PSM } from "tesseract.js";
import workerPath from "tesseract.js/dist/worker.min.js?url";
import corePath from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";

export async function readTicketPhoto(photo: File): Promise<string> {
  const image = await createImageBitmap(photo);
  try {
    if (image.width * image.height > 20_000_000) throw new Error("The photo is too large to read. Try a smaller image.");
    const scale = Math.min(2, 3000 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot read the photo.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const langPath = new URL("ocr", new URL(import.meta.env.BASE_URL, window.location.origin)).href;
    let rejectStartup: (error: Error) => void = () => {};
    let timer = 0;
    const failure = new Promise<never>((_, reject) => {
      rejectStartup = reject;
      timer = window.setTimeout(() => reject(new Error("The ticket reader took too long to start.")), 30000);
    });
    const starting = createWorker("eng", OEM.LSTM_ONLY, {
      workerPath, corePath, langPath,
      errorHandler: () => rejectStartup(new Error("The ticket reader could not be loaded.")),
    });
    let worker;
    try {
      worker = await Promise.race([starting, failure]);
    } catch (error) {
      void starting.then((lateWorker) => lateWorker.terminate()).catch(() => {});
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      const result = await worker.recognize(canvas);
      return result.data.text;
    } finally {
      await worker.terminate();
    }
  } finally {
    image.close();
  }
}