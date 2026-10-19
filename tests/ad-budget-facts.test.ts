import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("only launched campaigns count toward the planned daily budget", () => {
  const src = readFileSync("src/lib/company-facts.ts", "utf8");
  assert.match(src, /r\.status === "launched"/);
});

test("the live voice prompt forbids naming a currency", () => {
  const src = readFileSync("src/app/api/voice/live/route.ts", "utf8");
  assert.match(src, /only name a currency when the data gives one/i);
});
