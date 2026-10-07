/**
 * Can a live <Connect><Stream> actually be answered right now?
 *
 * The live Gemini bridge (bridge.ts) is a WebSocket server that needs a long-lived Node process.
 * It never starts on Vercel (startVoiceBridge returns false when VERCEL is set), and the
 * /api/voice/stream rewrite points at 127.0.0.1, so on Vercel the stream only works when
 * VOICE_STREAM_URL points at a bridge hosted somewhere else. Everywhere else (`next dev`,
 * `next start`, a VPS) the bridge runs inside the app, so behaviour there is unchanged.
 *
 * Without this check, a Vercel deployment sent every call into a stream nobody was listening on
 * and the caller heard "Sorry, the connection was lost".
 */
export function liveStreamReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.VERCEL || Boolean(env.VOICE_STREAM_URL?.trim());
}
