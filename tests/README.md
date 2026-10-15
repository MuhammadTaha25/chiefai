# Tests

`npm test` runs everything (node's built-in runner, no extra dependencies).

## Simulated pipeline tests (`sim-*.test.ts`)
These run the REAL sending code (`sendBatchForClient`, `runFollowUpBatch`, `reserveMailboxSlot`, warm-up, mailbox
health, domain checks, compliance footer, deliverability lint) against stand-ins for the outside world:

| Real | Stand-in (tests/helpers) |
| --- | --- |
| Supabase | `fake-db.ts` - in-memory tables; throws on any query feature it does not implement |
| Mailgun (`sendMail`, readiness) | `sim.ts` `mailer` - records every email, can be told to fail or report a domain "not ready" |
| Gemini drafting | `sim.ts` `ai` - records what it was asked, can fail |
| The clock | `mock.timers` Date, so a 3-day follow-up gap runs in milliseconds |

No network is used and no email is ever sent. Needs `--experimental-test-module-mocks` and the `@/` alias loader
(both already in the `npm test` script).

To check a scenario yourself, seed with `seedClient / seedJob / seedCampaign / seedMailbox / seedLead / seedSentLead`,
move time with `setClock`, call the real function, then assert on `mailer.sent`, `leadRow(id)` and `db.all("outreach_log")`.

Note: a mailbox older than ~15 days is "fully warmed" and always gets at least 30/day whatever limit is saved on it. To test
a small limit, use a mailbox younger than that (the helpers default to 10 days in `world()`).
