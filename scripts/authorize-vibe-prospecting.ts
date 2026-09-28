/**
 * ONE-TIME setup script — run this yourself, once:
 *
 *   npx tsx scripts/authorize-vibe-prospecting.ts
 *
 * It starts a temporary local server, opens the Vibe Prospecting login page
 * in your browser, and once you authorize, saves the resulting OAuth tokens
 * to Supabase. After this, src/lib/vibe-prospecting-mcp.ts reuses those
 * tokens for every request — no further interaction needed, ever, unless
 * the refresh token itself is revoked.
 */
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

const envPath = path.resolve(__dirname, "..", ".env.local");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) process.env[match[1]] = match[2].trim();
}

const VIBE_PROSPECTING_URL = "https://vibeprospecting.explorium.ai/mcp";
const REDIRECT_PORT = 8765;
process.env.VIBE_PROSPECTING_REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

async function main() {
  // Import after env vars are set, and after the redirect URI override above,
  // so the provider picks up the right value.
  const { SupabaseOAuthClientProvider } = await import("../src/lib/vibe-prospecting-mcp");
  const provider = new SupabaseOAuthClientProvider();

  const authCode = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "", `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(`Authorization failed: ${error}`));
        return;
      }
      if (code) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Vibe Prospecting is now connected to Infomist. You can close this tab.");
        server.close();
        resolve(code);
        return;
      }
      res.writeHead(400);
      res.end("Missing code");
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`\nWaiting for authorization on http://localhost:${REDIRECT_PORT}/callback ...`);
    });
  }).catch((err) => {
    throw err;
  });

  console.log("\nAuthorization code received — exchanging for tokens...");

  const result = await auth(provider, { serverUrl: VIBE_PROSPECTING_URL, authorizationCode: authCode });

  if (result === "AUTHORIZED") {
    console.log("\n✅ Vibe Prospecting is now connected and saved to Supabase.");
    console.log("Every future lead-gen request will use this shared connection automatically.");
  } else {
    console.log("\nUnexpected result:", result);
  }
}

// The SDK calls provider.redirectToAuthorization(url) as part of `auth()` —
// override it here (rather than in the class itself) so this script can
// print/open the URL, while production code keeps throwing if it's ever
// reached unexpectedly.
import { SupabaseOAuthClientProvider as ProviderClass } from "../src/lib/vibe-prospecting-mcp";
ProviderClass.prototype.redirectToAuthorization = async function (authorizationUrl: URL) {
  console.log("\nOpen this URL in your browser to authorize Vibe Prospecting:\n");
  console.log(authorizationUrl.toString());
  console.log("\n(If a browser doesn't open automatically, copy-paste the URL above.)\n");
  try {
    const { exec } = await import("child_process");
    exec(`start "" "${authorizationUrl.toString()}"`);
  } catch {
    // Non-fatal — the printed URL above still works if auto-open fails.
  }
};

main().catch((err) => {
  console.error("\n❌ Authorization failed:", err.message);
  process.exit(1);
});
