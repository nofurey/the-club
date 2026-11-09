import assert from "node:assert/strict";
import test from "node:test";

import { decodeOcrModel, emptyOcrModel, findPhotoExample, hasLearnableOcrRows, learnOcrCorrections, parseWithOcrModel, rememberPhotoExample } from "./ticket-ocr-learning";
import { clearOcrModel, loadOcrModel, saveOcrModel } from "./ticket-ocr-learning-store";

const rules = { mainNumberCount: 5, mainNumberMin: 1, mainNumberMax: 69, bonusNumberMin: 1, bonusNumberMax: 26 };
const text = "A O5 12 23 34 45 - 11 QP";
const confirmed = [{ numbers: [5, 12, 23, 34, 45], bonusNumber: 11 }];

test("learns an OCR confusion only after independent confirmed examples", () => {
  let model = emptyOcrModel();
  assert.equal(parseWithOcrModel(text, rules, model).plays.length, 0);
  model = learnOcrCorrections(model, text, confirmed, "photo-1");
  model = learnOcrCorrections(model, text, confirmed, "photo-1");
  model = learnOcrCorrections(model, text, confirmed, "photo-2");
  assert.equal(parseWithOcrModel(text, rules, model).plays.length, 0);
  model = learnOcrCorrections(model, text, confirmed, "photo-3");
  assert.deepEqual(parseWithOcrModel(text, rules, model).plays, confirmed);
});

test("does not learn from misaligned or conflicting confirmations", () => {
  let model = emptyOcrModel();
  model = learnOcrCorrections(model, text, [{ numbers: [5, 12, 23, 34, 46], bonusNumber: 11 }], "mismatched");
  assert.deepEqual(model, emptyOcrModel());
  for (const id of ["photo-1", "photo-2", "photo-3"]) model = learnOcrCorrections(model, text, confirmed, id);
  for (const id of ["photo-4", "photo-5"]) model = learnOcrCorrections(model, text, [{ numbers: [15, 12, 23, 34, 45], bonusNumber: 11 }], id);
  assert.equal(parseWithOcrModel(text, rules, model).plays.length, 0);
});

test("recognizes trainable rows and rejects corrupted stored models", () => {
  assert.equal(hasLearnableOcrRows(text), true);
  assert.equal(hasLearnableOcrRows("A 05 12 23 34 45 - 11 QP"), false);
  assert.equal(hasLearnableOcrRows("ticket text was not recognized"), false);
  assert.deepEqual(decodeOcrModel("not json"), emptyOcrModel());
  assert.deepEqual(decodeOcrModel(JSON.stringify({ version: 1, corrections: { O5: { 5: -1 } }, photoHashes: [] })), emptyOcrModel());
  const model = learnOcrCorrections(emptyOcrModel(), text, confirmed, "a".repeat(64));
  assert.deepEqual(decodeOcrModel(JSON.stringify(model)), model);
});

test("stores only model data per user and allows it to be cleared", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const model = learnOcrCorrections(emptyOcrModel(), text, confirmed, "a".repeat(64));
  assert.equal(saveOcrModel(storage, "user-1", model), true);
  assert.deepEqual(loadOcrModel(storage, "user-1"), model);
  assert.deepEqual(loadOcrModel(storage, "user-2"), emptyOcrModel());
  assert.equal([...values.values()][0].includes(text), false);
  assert.equal(clearOcrModel(storage, "user-1"), true);
  assert.deepEqual(loadOcrModel(storage, "user-1"), emptyOcrModel());
});

test("does not learn unreadable or numeric-only scans and tolerates unavailable storage", () => {
  assert.deepEqual(learnOcrCorrections(emptyOcrModel(), "unreadable photo", confirmed, "photo-1"), emptyOcrModel());
  assert.deepEqual(learnOcrCorrections(emptyOcrModel(), "A 05 12 23 34 45 - 11", confirmed, "photo-2"), emptyOcrModel());
  const unavailable = {
    getItem: () => { throw new Error("unavailable"); },
    setItem: () => { throw new Error("unavailable"); },
    removeItem: () => { throw new Error("unavailable"); },
  };
  assert.deepEqual(loadOcrModel(unavailable, "user-1"), emptyOcrModel());
  assert.equal(saveOcrModel(unavailable, "user-1", emptyOcrModel()), false);
  assert.equal(clearOcrModel(unavailable, "user-1"), false);
});

test("remembers confirmed plays only for the exact photo and matching game rules", () => {
  const hash = "a".repeat(64);
  const model = rememberPhotoExample(emptyOcrModel(), hash, "powerball", confirmed);
  assert.deepEqual(findPhotoExample(model, hash, "powerball", rules), confirmed);
  assert.equal(findPhotoExample(model, "b".repeat(64), "powerball", rules), null);
  assert.equal(findPhotoExample(model, hash, "mega_millions", rules), null);
  assert.equal(findPhotoExample(model, hash, "powerball", { ...rules, bonusNumberMax: 10 }), null);
  assert.deepEqual(decodeOcrModel(JSON.stringify(model)), model);
});

test("keeps remembered photo examples when learning OCR corrections", () => {
  const hash = "a".repeat(64);
  const model = rememberPhotoExample(emptyOcrModel(), hash, "powerball", confirmed);
  const updated = learnOcrCorrections(model, text, confirmed, hash);
  assert.deepEqual(findPhotoExample(updated, hash, "powerball", rules), confirmed);
});

test("loads existing correction models without photo examples", () => {
  const hash = "a".repeat(64);
  const existing = { version: 1, corrections: { O5: { 5: 3 } }, photoHashes: [hash] };
  const model = decodeOcrModel(JSON.stringify(existing));
  assert.deepEqual(model, { ...existing, examples: [] });
  assert.deepEqual(parseWithOcrModel(text, rules, model).plays, confirmed);
});

test("bounds photo examples and rejects invalid stored entries", () => {
  let model = emptyOcrModel();
  for (let index = 0; index < 51; index++) {
    model = rememberPhotoExample(model, index.toString(16).padStart(64, "0"), "powerball", confirmed);
  }
  assert.equal(model.examples.length, 50);
  assert.equal(findPhotoExample(model, "0".repeat(64), "powerball", rules), null);
  const invalid = { ...model, examples: [{ photoHash: "a".repeat(64), lottery: "powerball", plays: [{ numbers: [1, 1, 2, 3, 4], bonusNumber: 1 }] }] };
  assert.deepEqual(decodeOcrModel(JSON.stringify(invalid)), emptyOcrModel());
});