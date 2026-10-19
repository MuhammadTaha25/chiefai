/**
 * ChiefAI — Daily DNS Health Check
 *
 * Fires once a day (03:00, the n8n instance's timezone) and calls GET /api/cron/dns-health
 * with the CRON_SECRET header. The route re-checks SPF/DKIM/MX/CNAME/DMARC for every active
 * domain and stores the per-record result (shown under Settings -> Domains). It never writes DNS.
 *
 * Required credential in n8n (shared with the other ChiefAI cron workflows):
 *   Type: "Header Auth"  →  Name field: "Authorization"  →  Value: "Bearer <CRON_SECRET>"
 */

import { workflow, trigger, node, sticky, newCredential } from '@n8n/workflow-sdk';

const dailySchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every Day 03:00',
    parameters: {
      rule: {
        interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 0 }],
      },
    },
    position: [240, 300],
  },
  output: [{}],
});

const callDnsHealth = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'GET /api/cron/dns-health',
    parameters: {
      method: 'GET',
      url: 'https://infomistqa4827.online/api/cron/dns-health',
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
  output: [{ statusCode: 200, body: { ok: true, checked: 0 } }],
});

const helpNote = sticky(
  '## ChiefAI — Daily DNS Health Check\n\n' +
  '**What it does:** Calls `GET /api/cron/dns-health` once a day. Checks SPF, DKIM, MX, CNAME and DMARC of every active domain\n' +
  'and saves the result for Settings → Domains. Detect and report only.\n\n' +
  '**Credential:** Same `ChiefAI Cron Secret` as the other workflows.\n\n' +
  '**Publish only after** the dns-health route is merged and deployed, otherwise the call returns 404.',
  [dailySchedule, callDnsHealth],
  { color: 5 },
);

export default workflow('chiefai-dns-health', 'ChiefAI — Daily DNS Health Check')
  .add(helpNote)
  .add(dailySchedule)
  .to(callDnsHealth);
