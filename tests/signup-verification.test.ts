import test from "node:test";
import assert from "node:assert/strict";
import {
  startVerification,
  checkVerification,
  normalizeEmail,
  type VerificationDeps,
  type VerificationRow,
} from "../src/lib/signup-verification-core.ts";

function fakeDeps(overrides: Partial<VerificationDeps> = {}): VerificationDeps & { rows: Map<string, VerificationRow> } {
  const rows = new Map<string, VerificationRow>();
  let clock = new Date("2026-01-01T00:00:00Z");
  return {
    rows,
    async getLatestForEmail(email) {
      return rows.get(email) ?? null;
    },
    async insertVerification(email, code, token, expiresAtISO) {
      rows.set(email, { code, token, status: "pending", attempts: 0, expiresAtISO });
    },
    async incrementAttempts(email) {
      const row = rows.get(email);
      if (row) row.attempts += 1;
    },
    async markVerified(email) {
      const row = rows.get(email);
      if (row) row.status = "verified";
    },
    randomCode: () => "123456",
    randomToken: () => "tok_abc",
    now: () => clock,
    ...overrides,
  };
}

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  Foo@Example.com "), "foo@example.com");
});

test("startVerification stores a pending row with a code and token", async () => {
  const deps = fakeDeps();
  const result = await startVerification(deps, "User@Example.com");
  assert.equal(result.email, "user@example.com");
  assert.equal(result.code, "123456");
  assert.equal(result.token, "tok_abc");
  assert.equal(deps.rows.get("user@example.com")?.status, "pending");
});

test("checkVerification accepts the right code", async () => {
  const deps = fakeDeps();
  await startVerification(deps, "a@b.com");
  const result = await checkVerification(deps, "a@b.com", { code: "123456" });
  assert.deepEqual(result, { ok: true });
  assert.equal(deps.rows.get("a@b.com")?.status, "verified");
});

test("checkVerification accepts the right link token", async () => {
  const deps = fakeDeps();
  await startVerification(deps, "a@b.com");
  const result = await checkVerification(deps, "a@b.com", { token: "tok_abc" });
  assert.deepEqual(result, { ok: true });
});

test("checkVerification rejects a wrong code and increments attempts", async () => {
  const deps = fakeDeps();
  await startVerification(deps, "a@b.com");
  const result = await checkVerification(deps, "a@b.com", { code: "000000" });
  assert.deepEqual(result, { ok: false, reason: "wrong_code" });
  assert.equal(deps.rows.get("a@b.com")?.attempts, 1);
});

test("checkVerification locks out after too many wrong attempts", async () => {
  const deps = fakeDeps();
  await startVerification(deps, "a@b.com");
  for (let i = 0; i < 5; i++) await checkVerification(deps, "a@b.com", { code: "wrong" });
  const result = await checkVerification(deps, "a@b.com", { code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "too_many_attempts" });
});

test("checkVerification rejects an expired code even if correct", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const deps = fakeDeps({ now: () => clock });
  await startVerification(deps, "a@b.com");
  clock = new Date("2026-01-01T01:00:00Z"); // 1h later, past the 15-minute TTL
  const result = await checkVerification(deps, "a@b.com", { code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "expired" });
});

test("checkVerification returns not_found for an email with no verification started", async () => {
  const deps = fakeDeps();
  const result = await checkVerification(deps, "nobody@b.com", { code: "123456" });
  assert.deepEqual(result, { ok: false, reason: "not_found" });
});

test("checkVerification is idempotent once already verified", async () => {
  const deps = fakeDeps();
  await startVerification(deps, "a@b.com");
  await checkVerification(deps, "a@b.com", { code: "123456" });
  const second = await checkVerification(deps, "a@b.com", { code: "123456" });
  assert.deepEqual(second, { ok: true });
});
