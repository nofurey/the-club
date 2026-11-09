import assert from "node:assert/strict";
import test from "node:test";

import { parseTicketPlays } from "./ticket-ocr-parser";

const rules = { mainNumberCount: 5, mainNumberMin: 1, mainNumberMax: 69, bonusNumberMin: 1, bonusNumberMax: 26 };

test("extracts complete plays without treating dates or codes as ticket numbers", () => {
  const result = parseTicketPlays("POWERBALL\nA. 01 05 07 13 26 - 10\nB 02 06 12 56 63 - 19 QP\nDRAW 11 09 26\nA123 45 67 89 01 23 45", rules);
  assert.deepEqual(result, { plays: [{ numbers: [1, 5, 7, 13, 26], bonusNumber: 10 }, { numbers: [2, 6, 12, 56, 63], bonusNumber: 19 }], unrecognizedLines: 0 });
});

test("does not silently accept ambiguous or invalid plays", () => {
  const result = parseTicketPlays("A 01 01 07 13 26 - 10\nB 02 06 12 56 ?? - 19\nC 01 05 07 13 26 - 99", rules);
  assert.deepEqual(result, { plays: [], unrecognizedLines: 3 });
});

test("accepts common OCR spacing around play labels and quick-pick markers", () => {
  const result = parseTicketPlays("A | 01 05 07 13 26 - 10 Q P\nB. 02 06 12 56 63 - 19 Q.P.", rules);
  assert.deepEqual(result, { plays: [{ numbers: [1, 5, 7, 13, 26], bonusNumber: 10 }, { numbers: [2, 6, 12, 56, 63], bonusNumber: 19 }], unrecognizedLines: 0 });
});