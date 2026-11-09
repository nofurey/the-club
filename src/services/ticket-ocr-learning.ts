import type { TicketDrawingOption, TicketNumberSetInput } from "../api/contracts";
import type { LotteryType } from "../domain";
import { parseTicketPlays } from "./ticket-ocr-parser";

export interface OcrPhotoExample {
  photoHash: string;
  lottery: LotteryType;
  plays: TicketNumberSetInput[];
}

export interface OcrCorrectionModel {
  version: 1;
  corrections: Record<string, Record<string, number>>;
  photoHashes: string[];
  examples: OcrPhotoExample[];
}

export function emptyOcrModel(): OcrCorrectionModel {
  return { version: 1, corrections: {}, photoHashes: [], examples: [] };
}

function validPlays(value: unknown): value is TicketNumberSetInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return false;
  return value.every((play) => play && typeof play === "object" && Array.isArray(play.numbers) && play.numbers.length === 5 &&
    new Set(play.numbers).size === 5 && play.numbers.every((number: unknown) => Number.isInteger(number) && (number as number) >= 1 && (number as number) <= 70) &&
    Number.isInteger(play.bonusNumber) && play.bonusNumber >= 1 && play.bonusNumber <= 26);
}

export function decodeOcrModel(value: string | null): OcrCorrectionModel {
  if (!value || value.length > 100_000) return emptyOcrModel();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return emptyOcrModel();
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || !candidate.corrections || typeof candidate.corrections !== "object" || Array.isArray(candidate.corrections) || !Array.isArray(candidate.photoHashes)) return emptyOcrModel();
    const corrections: OcrCorrectionModel["corrections"] = {};
    for (const [token, rawCounts] of Object.entries(candidate.corrections)) {
      if (!/^[0-9OILSBZ]{1,2}$/.test(token) || /^\d+$/.test(token) || !rawCounts || typeof rawCounts !== "object" || Array.isArray(rawCounts)) return emptyOcrModel();
      const counts: Record<string, number> = {};
      for (const [number, count] of Object.entries(rawCounts)) {
        if (!/^(?:0|[1-9]\d?)$/.test(number) || !Number.isInteger(count) || (count as number) < 1 || (count as number) > 1000) return emptyOcrModel();
        counts[number] = count as number;
      }
      corrections[token] = counts;
    }
    if (Object.keys(corrections).length > 256 || candidate.photoHashes.length > 200 || candidate.photoHashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) return emptyOcrModel();
    const rawExamples = candidate.examples ?? [];
    if (!Array.isArray(rawExamples) || rawExamples.length > 50) return emptyOcrModel();
    const examples: OcrPhotoExample[] = [];
    for (const rawExample of rawExamples) {
      if (!rawExample || typeof rawExample !== "object") return emptyOcrModel();
      const example = rawExample as Record<string, unknown>;
      if (typeof example.photoHash !== "string" || !/^[a-f0-9]{64}$/.test(example.photoHash) || (example.lottery !== "powerball" && example.lottery !== "mega_millions") || !validPlays(example.plays)) return emptyOcrModel();
      examples.push({ photoHash: example.photoHash, lottery: example.lottery, plays: example.plays.map((play) => ({ numbers: [...play.numbers], bonusNumber: play.bonusNumber })) });
    }
    return { version: 1, corrections, photoHashes: candidate.photoHashes as string[], examples };
  } catch {
    return emptyOcrModel();
  }
}

export function rememberPhotoExample(model: OcrCorrectionModel, photoHash: string, lottery: LotteryType, plays: TicketNumberSetInput[]): OcrCorrectionModel {
  if (!/^[a-f0-9]{64}$/.test(photoHash) || !validPlays(plays)) return model;
  const example = { photoHash, lottery, plays: plays.map((play) => ({ numbers: [...play.numbers], bonusNumber: play.bonusNumber })) };
  const existing = model.examples.find((item) => item.photoHash === photoHash && item.lottery === lottery);
  if (existing && JSON.stringify(existing.plays) === JSON.stringify(example.plays)) return model;
  return { ...model, examples: [...model.examples.filter((item) => item.photoHash !== photoHash || item.lottery !== lottery), example].slice(-50) };
}

export function findPhotoExample(model: OcrCorrectionModel, photoHash: string, lottery: LotteryType, rules: NonNullable<TicketDrawingOption["numberRules"]>): TicketNumberSetInput[] | null {
  const example = model.examples.find((item) => item.photoHash === photoHash && item.lottery === lottery);
  if (!example || example.plays.some((play) => play.numbers.length !== rules.mainNumberCount || play.numbers.some((number) => number < rules.mainNumberMin || number > rules.mainNumberMax) || play.bonusNumber < rules.bonusNumberMin || play.bonusNumber > rules.bonusNumberMax)) return null;
  return example.plays.map((play) => ({ numbers: [...play.numbers], bonusNumber: play.bonusNumber }));
}

function readRow(line: string): { label: string; tokens: string[] } | null {
  const match = line.match(/^\s*([A-T])[.\s:)|]+([0-9OILSBZ]{1,2})\s+([0-9OILSBZ]{1,2})\s+([0-9OILSBZ]{1,2})\s+([0-9OILSBZ]{1,2})\s+([0-9OILSBZ]{1,2})\s*(?:[-|:]\s*|\s+)([0-9OILSBZ]{1,2})(?:\s*(?:Q[.\s]*P\.?|Q|P))?\s*$/i);
  return match ? { label: match[1].toUpperCase(), tokens: match.slice(2, 8).map((token) => token.toUpperCase()) } : null;
}

export function hasLearnableOcrRows(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const row = readRow(line);
    return row !== null && row.tokens.some((token) => !/^\d+$/.test(token)) && row.tokens.filter((token) => /^\d+$/.test(token)).length >= 3;
  });
}

export function learnOcrCorrections(model: OcrCorrectionModel, text: string, confirmed: TicketNumberSetInput[], photoHash: string): OcrCorrectionModel {
  if (!photoHash || model.photoHashes.includes(photoHash) || confirmed.length === 0 || confirmed.length > 20) return model;
  const rows = text.split(/\r?\n/).map(readRow).filter((row): row is NonNullable<typeof row> => row !== null);
  if (rows.length !== confirmed.length || rows.some((row, index) => row.label !== String.fromCharCode(65 + index))) return model;

  const observations = new Map<string, number | null>();
  rows.forEach((row, index) => {
    const values = [...confirmed[index].numbers, confirmed[index].bonusNumber];
    if (values.length !== 6 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 99)) return;
    const anchors = row.tokens.filter((token, tokenIndex) => /^\d+$/.test(token) && Number(token) === values[tokenIndex]).length;
    const mismatch = row.tokens.some((token, tokenIndex) => /^\d+$/.test(token) && Number(token) !== values[tokenIndex]);
    if (anchors < 3 || mismatch) return;
    row.tokens.forEach((token, tokenIndex) => {
      if (/^\d+$/.test(token)) return;
      const previous = observations.get(token);
      observations.set(token, previous === undefined || previous === values[tokenIndex] ? values[tokenIndex] : null);
    });
  });

  const usable = [...observations].filter((entry): entry is [string, number] => entry[1] !== null);
  if (!usable.length) return model;
  const corrections = Object.fromEntries(Object.entries(model.corrections).map(([token, counts]) => [token, { ...counts }]));
  for (const [token, value] of usable) {
    const counts = corrections[token] ?? {};
    counts[String(value)] = Math.min(1000, (counts[String(value)] ?? 0) + 1);
    corrections[token] = counts;
  }
  return { ...model, corrections, photoHashes: [...model.photoHashes, photoHash].slice(-200) };
}

export function parseWithOcrModel(text: string, rules: NonNullable<TicketDrawingOption["numberRules"]>, model: OcrCorrectionModel) {
  const normalized = text.split(/\r?\n/).map((line) => {
    const row = readRow(line);
    if (!row) return line;
    const tokens = row.tokens.map((token) => {
      if (/^\d+$/.test(token)) return token;
      const counts = Object.entries(model.corrections[token] ?? {}).sort((left, right) => right[1] - left[1]);
      const total = counts.reduce((sum, entry) => sum + entry[1], 0);
      if (!counts.length || counts[0][1] < 3 || counts[0][1] / total < 0.9) return token;
      return counts[0][0];
    });
    return `${row.label} ${tokens.slice(0, 5).join(" ")} - ${tokens[5]}`;
  }).join("\n");
  return parseTicketPlays(normalized, rules);
}