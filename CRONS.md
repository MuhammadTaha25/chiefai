# Scheduled jobs (moved out of vercel.json)

The Vercel Hobby plan only allows cron jobs that run once a day, so `vercel.json` no longer declares any and the app
deploys on Hobby. Nothing runs by itself until something calls these URLs on a schedule. Use a free scheduler such as
https://cron-job.org: create one job per row, method **GET**, URL `https://<your-app>.vercel.app<path>`, and add the header
`Authorization: Bearer <CRON_SECRET>` (the value from your environment variables).

| Schedule | Path |
|---|---|
| `*/30 * * * *` | `/api/cron/social-content/post` |
| `*/30 * * * *` | `/api/cron/social-content/story` |
| `0 * * * *` | `/api/cron/follow-ups` |
| `0 * * * *` | `/api/campaigns/send-daily-batch` |
| `0 * * * *` | `/api/cron/voice-daily-call` |
| `*/10 * * * *` | `/api/cron/sync-endpoints` |
| `*/5 * * * *` | `/api/cron/domain-provisioning` |
| `*/5 * * * *` | `/api/cron/calendly-sync` |
| `*/30 * * * *` | `/api/ads/sync` |
| `*/5 * * * *` | `/api/cron/social-initial` |

Only the first, second and last rows matter for social media (scheduled posts/stories and the first-connection cycle).
Comment and DM replies do NOT need a scheduler — they arrive by Zernio webhook.

**Video**: a video takes several minutes to render, but Hobby functions stop at 300 seconds, so video posts need the Pro plan.
On Pro, put the crons back into `vercel.json` as `{ "crons": [ { "path": "...", "schedule": "..." } ] }` and raise
`maxDuration` to 800 in the three social routes.
