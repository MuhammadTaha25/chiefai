# Run the voice bridge on your PC (test only)

1. Install Node 22+ and `cloudflared` (or ngrok).
2. In the repo (branch `feat/voice-quality`): `npm install`.
3. Start the bridge (PowerShell example):
   ```
   $env:GEMINI_API_KEY="<same key as Vercel>"
   $env:VOICE_FACTS_SECRET="<same as Vercel VOICE_FACTS_SECRET, or N8N_WEBHOOK_SECRET>"
   $env:VOICE_APP_INTERNAL_URL="https://<your-vercel-domain>"
   npm run voice:bridge
   ```
   You should see `[voice] standalone bridge up on port 8787, path /stream`.
4. In a second window: `cloudflared tunnel --url http://127.0.0.1:8787` -> note the `https://xxxx.trycloudflare.com` address.
5. In Vercel -> Environment Variables (Production) set `VOICE_STREAM_URL=wss://xxxx.trycloudflare.com/stream`, then redeploy.
6. Make the test call. Watch the bridge window for `[voice] tool ...` lines.

**While `VOICE_STREAM_URL` points at your PC, every call to the production number goes to your PC.** If the PC or tunnel is off, callers hear "connection lost".
When finished: delete `VOICE_STREAM_URL` in Vercel and redeploy (calls go back to the spoken-report flow).
Do not paste keys into chat; set them only in your own terminal or Vercel.
