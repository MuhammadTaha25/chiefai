import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startOwnershipChallenge,
  checkOwnershipChallenge,
  evaluateDomainUsable,
  normalizeDomain,
  verificationHostname,
  type OwnershipDeps,
  type OwnershipRow,
  type ChallengeRow,
} from "../src/lib/domain-ownership-core.ts";

/**
 * In-memory fake of the DB + DNS so the ownership logic can be tested
 * without a real Supabase project or real DNS resolution. Mirrors
 * src/lib/domain-ownership.ts's real wiring closely enough that these tests
 * exercise the same decision points.
 */
function fakeDeps(opts: { txtRecords?: Record<string, string[][]>; now?: Date } = {}) {
  const ownership = new Map<string, OwnershipRow>();
  const challenges = new Map<string, ChallengeRow>(); // key: `${clientId}:${domain}`
  let tokenCounter = 0;
  let now = opts.now ?? new Date("2026-01-01T00:00:00Z");
  const txtRecords = opts.txtRecords ?? {};

  const deps: OwnershipDeps = {
    async getOwnershipRow(domain) {
      return ownership.get(domain) ?? null;
    },
    async getChallenge(clientId, domain) {
      return challenges.get(`${clientId}:${domain}`) ?? null;
    },
    async upsertChallenge(clientId, domain, token, expiresAtISO) {
      challenges.set(`${clientId}:${domain}`, { token, status: "pending", expires_at: expiresAtISO });
    },
    async claimOwnership(domain, clientId) {
      // Mirrors the real ON CONFLICT (domain) DO NOTHING + re-select: only
      // the first caller for a domain can ever win.
      if (!ownership.has(domain)) {
        ownership.set(domain, { client_id: clientId });
      }
      const winner = ownership.get(domain)!;
      return { claimed: winner.client_id === clientId, ownerClientId: winner.client_id };
    },
    async markChallengeVerified(clientId, domain) {
      const row = challenges.get(`${clientId}:${domain}`);
      if (row) challenges.set(`${clientId}:${domain}`, { ...row, status: "verified" });
    },
    async resolveTxt(hostname) {
      const rows = txtRecords[hostname];
      if (!rows) throw new Error("ENOTFOUND");
      return rows;
    },
    now: () => now,
    randomToken: () => `token-${++tokenCounter}`,
  };

  return {
    deps,
    setNow(d: Date) {
      now = d;
    },
    setTxt(hostname: string, value: string) {
      txtRecords[hostname] = [[value]];
    },
    clearTxt(hostname: string) {
      delete txtRecords[hostname];
    },
    ownership,
    challenges,
  };
}

test("normalizeDomain validates shape and strips a trailing dot/case", () => {
  assert.equal(normalizeDomain("MyCompany.com"), "mycompany.com");
  assert.equal(normalizeDomain("mycompany.com."), "mycompany.com");
  assert.equal(normalizeDomain("  mycompany.com  "), "mycompany.com");
  assert.equal(normalizeDomain("not a domain"), null);
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain("-bad.com"), null);
});

test("1. Client A starts and completes a challenge successfully", async () => {
  const f = fakeDeps();
  const started = await startOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  assert.equal(started.ok, true);
  if (!started.ok || started.alreadyOwned) throw new Error("expected a fresh challenge");
  f.setTxt(started.hostname, started.token);

  const result = await checkOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  assert.deepEqual(result, { ok: true, state: "owned", domain: "mycompany.com" });
  assert.equal(f.ownership.get("mycompany.com")?.client_id, "client-a");
});

test("2. Client B cannot register the same domain once Client A owns it", async () => {
  const f = fakeDeps();
  f.ownership.set("mycompany.com", { client_id: "client-a" });

  const started = await startOwnershipChallenge(f.deps, "client-b", "mycompany.com");
  assert.equal(started.ok, false);
  if (started.ok) throw new Error("expected rejection");
  assert.match(started.error, /already connected to a different account/i);
});

test("3. Client B cannot bypass verification using Mailgun's 'active' state alone", async () => {
  // This is the actual P0 regression test: the old code trusted Mailgun's
  // shared domain state. The new ownership check never asks Mailgun
  // anything — it only trusts domain_ownership + an independent DNS TXT
  // lookup. Simulate Client B never having a challenge at all (as if they
  // skipped straight to "verify" hoping Mailgun's state alone would pass).
  const f = fakeDeps();
  f.ownership.set("mycompany.com", { client_id: "client-a" });
  const result = await checkOwnershipChallenge(f.deps, "client-b", "mycompany.com");
  assert.equal(result.ok, false);
  assert.equal(result.state, "owned_by_other");
});

test("4. A fake/incorrect TXT value fails verification", async () => {
  const f = fakeDeps();
  const started = await startOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  if (!started.ok || started.alreadyOwned) throw new Error("expected a fresh challenge");
  f.setTxt(started.hostname, "totally-wrong-value");

  const result = await checkOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  assert.equal(result.ok, false);
  assert.equal(result.state, "dns_mismatch");
  assert.equal(f.ownership.has("mycompany.com"), false, "a failed check must never claim ownership");
});

test("5. A correct TXT value succeeds for the correct client and domain", async () => {
  const f = fakeDeps();
  const started = await startOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  if (!started.ok || started.alreadyOwned) throw new Error("expected a fresh challenge");
  f.setTxt(started.hostname, started.token);
  const result = await checkOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  assert.equal(result.ok, true);
  assert.equal(result.state, "owned");
});

test("6. A challenge belonging to another client cannot be reused", async () => {
  const f = fakeDeps();
  const startedA = await startOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  if (!startedA.ok || startedA.alreadyOwned) throw new Error("expected a fresh challenge");
  f.setTxt(startedA.hostname, startedA.token);

  // Client B has its own (different) challenge for the same domain, with a
  // different token/hostname — B's DNS lookup must use B's own hostname,
  // which was never set, so it fails rather than accidentally reusing A's.
  const startedB = await startOwnershipChallenge(f.deps, "client-b", "mycompany.com");
  if (!startedB.ok || startedB.alreadyOwned) throw new Error("expected a fresh challenge for B too");
  assert.notEqual(startedB.hostname, startedA.hostname, "each client must get a distinct verification hostname");

  const resultB = await checkOwnershipChallenge(f.deps, "client-b", "mycompany.com");
  assert.equal(resultB.ok, false);
  assert.equal(resultB.state, "dns_not_found");
});

test("7. Expired challenges fail", async () => {
  const f = fakeDeps({ now: new Date("2026-01-01T00:00:00Z") });
  const started = await startOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  if (!started.ok || started.alreadyOwned) throw new Error("expected a fresh challenge");
  f.setTxt(started.hostname, started.token);

  // Jump forward past the 48h TTL.
  f.setNow(new Date("2026-01-05T00:00:00Z"));
  const result = await checkOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  assert.equal(result.ok, false);
  assert.equal(result.state, "expired");
});

test("8. Concurrent claims cannot create duplicate ownership (DB-level guarantee)", async () => {
  const f = fakeDeps();
  const startedA = await startOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  const startedB = await startOwnershipChallenge(f.deps, "client-b", "mycompany.com");
  if (!startedA.ok || startedA.alreadyOwned || !startedB.ok || startedB.alreadyOwned) throw new Error("expected fresh challenges");
  f.setTxt(startedA.hostname, startedA.token);
  f.setTxt(startedB.hostname, startedB.token);

  // Both pass their OWN independent DNS check "simultaneously" — only the
  // atomic claimOwnership can decide a single winner.
  const [resultA, resultB] = await Promise.all([
    checkOwnershipChallenge(f.deps, "client-a", "mycompany.com"),
    checkOwnershipChallenge(f.deps, "client-b", "mycompany.com"),
  ]);
  const outcomes = [resultA, resultB];
  const winners = outcomes.filter((r) => r.ok);
  const losers = outcomes.filter((r) => !r.ok);
  assert.equal(winners.length, 1, "exactly one caller must end up owning the domain");
  assert.equal(losers.length, 1);
  assert.equal((losers[0] as { state: string }).state, "owned_by_other");
  assert.equal(f.ownership.size, 1);
});

test("9a. evaluateDomainUsable blocks an external domain with no ownership row at all", () => {
  const result = evaluateDomainUsable(null, "client-a", /* requireExplicitOwnership */ true);
  assert.equal(result.usable, false);
  if (result.usable) throw new Error("expected blocked");
  assert.equal(result.reason, "ownership_not_verified");
});

test("9b. evaluateDomainUsable blocks any domain owned by a different client", () => {
  const result = evaluateDomainUsable({ client_id: "client-a" }, "client-b", false);
  assert.equal(result.usable, false);
  if (result.usable) throw new Error("expected blocked");
  assert.equal(result.reason, "owned_by_other");
});

test("9c. evaluateDomainUsable allows a legacy (pre-fix) purchased domain with no ownership row", () => {
  const result = evaluateDomainUsable(null, "client-a", /* requireExplicitOwnership */ false);
  assert.equal(result.usable, true);
});

test("9d. evaluateDomainUsable allows the domain's actual verified owner", () => {
  const result = evaluateDomainUsable({ client_id: "client-a" }, "client-a", true);
  assert.equal(result.usable, true);
});

test("10. verificationHostname embeds the token uniquely per domain", () => {
  assert.equal(verificationHostname("mycompany.com", "abc123"), "_infomist-verify-abc123.mycompany.com");
});

test("11. Existing purchased-domain functionality is unaffected: no challenge needed, no ownership row required to remain usable", () => {
  // A purchased domain never calls startOwnershipChallenge/checkOwnershipChallenge
  // at all in the real app (claimPurchasedDomainOwnership claims it directly) —
  // evaluateDomainUsable's permissive legacy branch (9c) is what guarantees a
  // domain predating this fix is never retroactively locked out.
  const result = evaluateDomainUsable(null, "client-a", false);
  assert.equal(result.usable, true);
});

test("12. Re-starting an already-owned domain's challenge short-circuits to alreadyOwned, never issuing a pointless new token", async () => {
  const f = fakeDeps();
  f.ownership.set("mycompany.com", { client_id: "client-a" });
  const started = await startOwnershipChallenge(f.deps, "client-a", "mycompany.com");
  assert.deepEqual(started, { ok: true, domain: "mycompany.com", alreadyOwned: true });
});
