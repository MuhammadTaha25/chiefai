/**
 * ChiefAI — Soft-bounce retry + meeting feedback
 *
 * Two schedules, every 30 minutes:
 *   GET /api/cron/bounce-retry      clears the soft-bounce hold on leads whose 24-hour retry time has passed
 *   GET /api/cron/meeting-feedback  asks the client for feedback on meetings that ended 5-6 hours ago
 * Both were written but never scheduled, so neither ever ran.
 *
 * Credential (same as the other ChiefAI cron workflows): "Header Auth", name "Authorization", value "Bearer <CRON_SECRET>".
 */

import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

const bounceSchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 30min - Soft Bounce Retry',
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 */30 * * * *' }] } },
    position: [240, 200],
  },
  output: [{}],
});

const callBounceRetry = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Call /api/cron/bounce-retry',
    parameters: {
      method: 'GET',
      url: 'https://infomistqa4827.online/api/cron/bounce-retry',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: { response: { response: { fullResponse: true, neverError: true } } },
    },
    credentials: { httpHeaderAuth: newCredential('ChiefAI Cron Secret') },
    position: [540, 200],
  },
  output: [{ statusCode: 200, body: { ok: true, processed: 0, cleared: 0 } }],
});

const feedbackSchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 30min - Meeting Feedback',
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 */30 * * * *' }] } },
    position: [240, 420],
  },
  output: [{}],
});

const callMeetingFeedback = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Call /api/cron/meeting-feedback',
    parameters: {
      method: 'GET',
      url: 'https://infomistqa4827.online/api/cron/meeting-feedback',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: { response: { response: { fullResponse: true, neverError: true } } },
    },
    credentials: { httpHeaderAuth: newCredential('ChiefAI Cron Secret') },
    position: [540, 420],
  },
  output: [{ statusCode: 200, body: { ok: true } }],
});

export default workflow('chiefai-bounce-feedback', 'ChiefAI — Soft Bounce Retry + Meeting Feedback')
  .add(bounceSchedule)
  .to(callBounceRetry)
  .add(feedbackSchedule)
  .to(callMeetingFeedback);
