"use client";

import { SocialPlatform, PLATFORM_META } from "@/types/social";

const PERMISSIONS = [
  "Create and publish posts",
  "Publish reels/videos",
  "Publish images",
  "Publish stories where supported",
  "Read comments",
  "Respond to comments",
  "Manage supported messaging/DM interactions",
  "View basic account insights",
];

export default function ConnectModal({
  platform,
  onClose,
}: {
  platform: SocialPlatform;
  onClose: () => void;
}) {
  const meta = PLATFORM_META[platform];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="panel float-layer w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h3 className="type-subhead text-ink">Connect {meta.label}</h3>
        </div>
        <div className="panel-body space-y-4">
          <p className="type-body text-ink-secondary">
            Connect your {meta.label} account so we can publish content and manage your social
            activity automatically.
          </p>
          <ul className="space-y-1.5">
            {PERMISSIONS.map((p) => (
              <li key={p} className="flex items-start gap-2 type-caption text-ink-secondary">
                <span className="mt-0.5 text-positive">✓</span>
                {p}
              </li>
            ))}
          </ul>
          <p className="type-caption text-ink-tertiary">
            You&apos;ll be redirected to {meta.label === "Instagram" || meta.label === "Facebook" ? "Meta" : meta.label}&apos;s
            official sign-in to authorize this — we never ask for your password.
          </p>
          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-md border border-strong px-4 py-2 type-caption font-semibold text-ink-secondary hover:bg-sunken"
            >
              Cancel
            </button>
            <a
              href={`/api/zernio/connect?platform=${meta.connKey}&next=/social`}
              className="flex-1 rounded-md bg-primary px-4 py-2 text-center type-caption font-semibold text-primary-foreground hover:bg-primary-hover"
            >
              Continue with {meta.label}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
