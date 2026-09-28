import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Next.js dev server rejects requests from any origin other than
  // localhost by default (DNS-rebinding protection). Without this, the app
  // loads over the LAN IP but never hydrates — assets return 200 but React
  // never attaches, so forms fall back to plain HTML submission and HMR's
  // websocket fails, which is exactly what breaks "network" login/signup.
  allowedDevOrigins: ["192.168.100.54", "192.168.100.*"],
  // `ws` opens real sockets; keep it out of the bundle.
  serverExternalPackages: ["ws"],
  // Twilio's media WebSocket enters through the app's own public origin (one
  // tunnel, one URL) and is forwarded to the live voice bridge (src/lib/voice/bridge.ts).
  async rewrites() {
    return [{ source: "/api/voice/stream", destination: `http://127.0.0.1:${process.env.VOICE_BRIDGE_PORT || 8787}/stream` }];
  },
};

export default nextConfig;
