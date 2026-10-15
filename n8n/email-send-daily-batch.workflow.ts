/**
 * ChiefAI — Hourly Email Send Batch
 *
 * Fires every hour during business hours (0 * * * *) and calls
 * POST /api/campaigns/send-daily-batch with the CRON_SECRET header.
 *
 * This runs for ALL active clients — the API route iterates over every
 * client that has an active campaign and eligible leads.
 *
 * Required credential in n8n:
 *   Type: "Header Auth"  →  Name field: "Authorization"  →  Value: "Bearer <CRON_SECRET>"
 *
 * Required env var on Vercel:
 *   CRON_SECRET=<same secret>
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
const callSendBatch = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'POST /api/campaigns/send-daily-batch',
    parameters: {
      method: 'POST',
      url: 'https://infomistqa4827.online/api/campaigns/send-daily-batch',
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
  output: [{ statusCode: 200, body: { sent: 0 } }],
});

// ── Sticky note ──────────────────────────────────────────────────────────────
const helpNote = sticky(
  '## ChiefAI — Hourly Email Send Batch\n\n' +
  '**What it does:** Calls `POST /api/campaigns/send-daily-batch` every hour.\n' +
  'The API iterates over all active clients, checks their send window, warmup\n' +
  'schedule, and daily cap, then dispatches emails via their assigned mailboxes.\n\n' +
  '**Credential setup:**\n' +
  '1. In n8n → Credentials → New → "Header Auth"\n' +
  '2. Name: `ChiefAI Cron Secret`\n' +
  '3. Name field: `Authorization`\n' +
  '4. Value field: `Bearer <your CRON_SECRET from Vercel env vars>`\n\n' +
  '**App URL:** Update the URL in the HTTP node if your domain differs from\n' +
  '`infomistqa4827.online`.',
  [hourlySchedule, callSendBatch],
  { color: 3 },
);

export default workflow('chiefai-email-send-daily-batch', 'ChiefAI — Hourly Email Send Batch')
  .add(helpNote)
  .add(hourlySchedule)
  .to(callSendBatch);
