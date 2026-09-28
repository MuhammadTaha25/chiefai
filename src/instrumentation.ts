/** Runs once when the Next.js server starts. Starts the in-app scheduler (see lib/in-app-scheduler.ts) and the live voice bridge. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startInAppScheduler } = await import("./lib/in-app-scheduler");
    startInAppScheduler();
    const { startVoiceBridge } = await import("./lib/voice/bridge");
    startVoiceBridge();
  }
}
