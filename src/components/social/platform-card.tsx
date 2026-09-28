"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SocialPlatform, SocialConnection, SocialAutomationSettings, PLATFORM_META } from "@/types/social";
import ConnectModal from "./connect-modal";
import AutomationWizard from "./automation-wizard";

export default function PlatformCard({
  platform,
  connection,
  settings,
  profileComplete,
  onChanged,
}: {
  platform: SocialPlatform;
  connection: SocialConnection | null;
  settings: SocialAutomationSettings | null;
  profileComplete: boolean;
  onChanged: () => void;
}) {
  const router = useRouter();
  const meta = PLATFORM_META[platform];
  const [showConnect, setShowConnect] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [busy, setBusy] = useState(false);

  const connected = connection?.connection_status === "connected";
  const active = settings?.automation_active;
  // Only DM automation needs Instagram's "message access" toggle — comment
  // automation uses a separate permission that works independently
  // (verified live: comments endpoint returns real data even when inbox is off).
  const needsInboxFix =
    connected &&
    (platform === "instagram" || platform === "facebook") &&
    settings?.dm_enabled &&
    connection?.inbox_enabled === false;
  const [checkingInbox, setCheckingInbox] = useState(false);

  async function recheckInbox() {
    setCheckingInbox(true);
    try {
      await fetch("/api/social/check-inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      onChanged();
    } finally {
      setCheckingInbox(false);
    }
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${meta.label}? This will pause its automation.`)) return;
    setBusy(true);
    try {
      await fetch("/api/social/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel panel-body">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="type-subhead text-ink">{meta.label}</h3>
            {meta.supportLevel === "coming_soon" && (
              <span className="badge-base badge-neutral">Coming soon</span>
            )}
          </div>
          <p className="mt-1 type-caption text-ink-tertiary">{meta.description}</p>
        </div>
      </div>

      {meta.supportLevel === "coming_soon" ? (
        <button disabled className="mt-4 w-full rounded-md border border-strong px-3 py-2 type-caption font-semibold text-ink-tertiary opacity-60">
          Coming soon
        </button>
      ) : !connected ? (
        <button
          onClick={() => setShowConnect(true)}
          className="mt-4 w-full rounded-md bg-primary px-3 py-2 type-caption font-semibold text-primary-foreground hover:bg-primary-hover"
        >
          Connect {meta.label}
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="badge-base badge-positive">Connected</span>
            {active ? (
              <span className="badge-base badge-accent">Automation active</span>
            ) : (
              <span className="badge-base badge-neutral">Not configured</span>
            )}
          </div>

          {active && settings && (
            <div className="tile p-3 space-y-1 type-caption text-ink-secondary">
              <p className="num text-ink">
                Saved preference: {settings.posts_per_week} posts/week{settings.stories_enabled ? ` · ${settings.stories_per_week} stories/week` : ""} (AI posts are created on the daily schedule; the weekly numbers are preferences only)
              </p>
              <ul className="space-y-0.5">
                <li className="text-ink-tertiary">✓ Post creation and publishing — from the Content page</li>
                {settings.dm_enabled && <li>✓ DM assistant</li>}
                {settings.comment_enabled && <li>✓ Comment assistant</li>}
              </ul>
            </div>
          )}

          {needsInboxFix && (
            <div className="tile p-3 space-y-2 type-caption text-caution">
              <p className="font-semibold">One more step for DM replies to work</p>
              <p>
                Open Instagram on your phone → <strong>Settings</strong> →{" "}
                <strong>Website permissions</strong> → <strong>Connected tools</strong> → turn on
                message access for this app. This is an Instagram setting — we can&apos;t switch it
                on for you.
              </p>
              <button
                onClick={recheckInbox}
                disabled={checkingInbox}
                className="rounded-md border border-strong px-3 py-1.5 type-caption font-semibold text-ink-secondary hover:bg-sunken disabled:opacity-50"
              >
                {checkingInbox ? "Checking…" : "I've done this — recheck"}
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!profileComplete) {
                  router.push(`/settings/business-profile?next=${encodeURIComponent("/social")}`);
                  return;
                }
                setShowWizard(true);
              }}
              className="flex-1 rounded-md border border-strong px-3 py-1.5 type-caption font-semibold text-ink-secondary hover:bg-sunken"
            >
              {!profileComplete ? "Complete business profile first" : active ? "Edit automation" : "Configure automation"}
            </button>
            <button
              onClick={disconnect}
              disabled={busy}
              className="rounded-md border border-strong px-3 py-1.5 type-caption font-semibold text-critical hover:bg-sunken disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {showConnect && <ConnectModal platform={platform} onClose={() => setShowConnect(false)} />}
      {showWizard && (
        <AutomationWizard
          platform={platform}
          existing={settings}
          onClose={() => setShowWizard(false)}
          onActivated={() => {
            setShowWizard(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
