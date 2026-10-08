# Facebook/Meta Ads — Image Upload & Launch Failure

## Status: Not a code bug — Meta permission issue

## Root cause

Recent failed `ad_campaigns` rows (2026-10-08) all fail at the same step with the same
underlying Meta error:

```
Zernio API /ads/images failed: 400
"To create or edit ads for ad account 1117922407334256,
contact an admin to get permission with an Advertiser role on the ad account."
```

The connected Facebook user/token does not hold the **Advertiser** role on
Meta Ad Account `1117922407334256`. Because of this:

1. AI image generation (Gemini, `generateSocialImage` in `src/lib/gemini.ts`) succeeds.
2. Uploading that image to Meta's image library (`uploadAdImage` in `src/lib/zernio.ts:538`)
   is rejected by Meta with the permission error above.
3. With no `imageUrl`/`imageHash`/`videoUrl` available, the app now fails fast with an
   actionable message (added in commit `3f423eb`, `src/app/api/ads/[platform]/route.ts:814-826`)
   instead of silently calling `createMetaAd` and getting a confusing
   `"imageUrl or video is required"` error from Zernio.
4. Ads also never "go live" automatically — campaigns are always created as `PAUSED`
   drafts (`src/app/api/ads/[platform]/route.ts:885`). Going live requires a separate
   `POST /api/ads/campaigns/[id]` call with `{ "action": "publish" }`
   (`src/app/api/ads/campaigns/[id]/route.ts:100`), which flips the Meta campaign status to
   `ACTIVE`. That step also depends on the same ad-account permission.

## Fix (must be done in Meta Business Manager, not in code)

1. Open **Meta Business Settings → Ad Accounts**.
2. Find ad account `1117922407334256`.
3. Add the connected app's Facebook user (or system user) with the **Advertiser** role
   on that ad account. An existing admin of the Business Manager/ad account must do this.
4. Retry the ad creation — no code or deploy changes are needed once the role is granted.

## Current deployment

- Latest production commit: `3f423eb` ("Ads: fail with a clear message when no creative
  media got attached") — already live.
- Live domain: https://infomistqa4827.online
