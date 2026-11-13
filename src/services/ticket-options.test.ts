import assert from "node:assert/strict";
import test from "node:test";

import { contributionCost, hasValidPlayOptions, playCostPerDrawing } from "./ticket-options";

test("prices Powerball add-ons per play per drawing and keeps Mega Millions at its ticket price", () => {
  assert.equal(playCostPerDrawing("powerball", 2, {}), 2);
  assert.equal(playCostPerDrawing("powerball", 2, { powerPlay: true }), 3);
  assert.equal(playCostPerDrawing("powerball", 2, { powerPlay: true, doublePlay: true }), 4);
  assert.equal(playCostPerDrawing("mega_millions", 5, { megaplier: 10 }), 5);
  assert.equal(contributionCost("powerball", 2, 3, [{}, { powerPlay: true }, { doublePlay: true }]), 24);
});

test("accepts only the add-ons each lottery offers", () => {
  assert.equal(hasValidPlayOptions("powerball", { powerPlay: true, doublePlay: true }), true);
  assert.equal(hasValidPlayOptions("powerball", { megaplier: 2 }), false);
  assert.equal(hasValidPlayOptions("mega_millions", { megaplier: 5 }), true);
  assert.equal(hasValidPlayOptions("mega_millions", {}), false);
  assert.equal(hasValidPlayOptions("mega_millions", { megaplier: 1 }), false);
  assert.equal(hasValidPlayOptions("mega_millions", { megaplier: 2, powerPlay: true }), false);
});
