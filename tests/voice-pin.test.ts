import test from "node:test";
import assert from "node:assert/strict";
import { hashPin, checkPin, normalisePin, recordPinResult, pinLocked } from "../src/lib/voice/pin.ts";

test("PIN hash verifies only the right PIN and is salted", () => {
  const h = hashPin("482913");
  assert.ok(checkPin("482913", h));
  assert.ok(!checkPin("482914", h));
  assert.notEqual(h, hashPin("482913"));
});
test("PIN must be 4-6 digits", () => {
  assert.equal(normalisePin("1234"), "1234");
  assert.equal(normalisePin("123"), null);
  assert.equal(normalisePin("12a45"), null);
});
test("5 wrong PINs lock the line", () => {
  for (let i = 0; i < 4; i++) recordPinResult("c1", false);
  assert.ok(!pinLocked("c1"));
  recordPinResult("c1", false);
  assert.ok(pinLocked("c1"));
  recordPinResult("c2", false); recordPinResult("c2", true);
  assert.ok(!pinLocked("c2"));
});
