import { decodeOcrModel, emptyOcrModel, type OcrCorrectionModel } from "./ticket-ocr-learning";

type OcrStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function keyFor(userId: string): string {
  return `the-club.ocr-corrections.v1.${userId}`;
}

export function loadOcrModel(storage: OcrStorage, userId: string): OcrCorrectionModel {
  try { return decodeOcrModel(storage.getItem(keyFor(userId))); } catch { return emptyOcrModel(); }
}

export function saveOcrModel(storage: OcrStorage, userId: string, model: OcrCorrectionModel): boolean {
  try { storage.setItem(keyFor(userId), JSON.stringify(model)); return true; } catch { return false; }
}

export function clearOcrModel(storage: OcrStorage, userId: string): boolean {
  try { storage.removeItem(keyFor(userId)); return true; } catch { return false; }
}