/**
 * ChiefAI — Hourly Follow-Up Emails
 *
 * Fires every hour (0 * * * *) and calls GET /api/cron/follow-ups
 * with the CRON_SECRET header.
 *
 * This picks up leads whose next_follow_up_at has passed and sends
 * the configured follow-up email.  Requires FOLLOW_UP_CRON_ENABLED=true
 * in Vercel env vars.
 *
 * Required credential in n8n (shared with send-daily-batch):
 *   Type: "Header Auth"  →  Name field: "Authorization"  →  Value: "Bearer <CRON_SECRET>"
 */

import { workflow, trigger, node, sticky, newCredential } from '@n8n/workflow-sdk';

// ── Schedule ────────────────────────────────────────────────────────────────
const hourlySchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every Hour',
    parameters: {
      rule: {
        interval: [
          {
            field: 'hours',
            hoursInterval: 1,
            triggerAtMinute: 0,
          },
        ],
      },
    },
    position: [240, 300],
  },
  output: [{}],
});

// ── HTTP call ────────────────────────────────────────────────────────────────
const callFollowUps = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GET /api/cron/follow-ups',
    parameters: {
      method: 'GET',
      url: 'https://infomistqa4827.online/api/cron/follow-ups',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {
        response: {
          response: {
            fullResponse: true,
            neverError: true, // log 4xx/5xx instead of throwing
          },
        },
      },
    },
    credentials: {
      httpHeaderAuth: newCredential('ChiefAI Cron Secret'),
    },
    position: [540, 300],
    onError: 'continueErrorOutput',
  },
  output: [{ statusCode: 200, body: { processed: 0 } }],
});

// ── Sticky note ──────────────────────────────────────────────────────────────
const helpNote = sticky(
  '## ChiefAI — Hourly Follow-Up Emails\n\n' +
  '**What it does:** Calls `GET /api/cron/follow-ups` every hour.\n' +
  'Picks up leads whose `next_follow_up_at` has passed and dispatches\n' +
  'the next follow-up email in their sequence.\n\n' +
  '**Required Vercel env var:** `FOLLOW_UP_CRON_ENABLED=true`\n\n' +
  '**Credential:** Same `ChiefAI Cron Secret` used by the send-daily-batch workflow.\n\n' +
  '**App URL:** Update the URL in the HTTP node if your domain differs from\n' +
  '`infomistqa4827.online`.',
  [hourlySchedule, callFollowUps],
  { color: 5 },
);

export default workflow('chiefai-email-follow-ups', 'ChiefAI — Hourly Follow-Up Emails')
  .add(helpNote)
  .add(hourlySchedule)
  .to(callFollowUps);
