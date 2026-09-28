interface SocialConnection {
  id: string;
  platform: string;
  connection_status: string | null;
  connected_at: string | null;
}

const PLATFORMS = ["instagram", "facebook", "google_ads"];

export default function IntegrationsPanel({ connections }: { connections: SocialConnection[] }) {
  return (
    <div className="mt-3 space-y-2">
      {PLATFORMS.map((platform) => {
        const conn = connections.find((c) => c.platform === platform);
        const connected = conn?.connection_status === "connected";
        return (
          <div
            key={platform}
            className="flex items-center justify-between rounded-md border border-black/[.08] px-4 py-3 text-sm dark:border-white/[.145]"
          >
            <div>
              <span className="font-medium capitalize">{platform.replace("_", " ")}</span>
              {connected && conn?.connected_at && (
                <p className="text-xs text-zinc-500">
                  Connected {new Date(conn.connected_at).toLocaleDateString()}
                </p>
              )}
            </div>
            <a
              href={`/api/zernio/connect?platform=${platform}`}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                connected
                  ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  : "bg-foreground text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
              }`}
            >
              {connected ? "Reconnect" : "Connect"}
            </a>
          </div>
        );
      })}
    </div>
  );
}
