"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import Link from "next/link";
import type { SocialConnection, SocialAutomationSettings, SocialPlatform } from "@/types/social";
import { PLATFORM_META } from "@/types/social";
import PlatformCard from "./platform-card";

const PLATFORMS: SocialPlatform[] = ["instagram", "facebook", "linkedin", "tiktok", "youtube"];

function ConnectionBanner() {
  const params = useSearchParams();
  const connected = params.get("zernio_connected");
  const error = params.get("zernio_error");
  if (!connected && !error) return null;
  return connected ? (
    <p className="panel panel-body type-caption text-positive">
      {PLATFORM_META[connected as SocialPlatform]?.label ?? connected} connected. Configure its automation below.
    </p>
  ) : (
    <p className="panel panel-body type-caption text-critical">Connection failed: {error}</p>
  );
}

export default function SocialPageClient({
  connections,
  settings,
  profileComplete,
}: {
  connections: SocialConnection[];
  settings: SocialAutomationSettings[];
  profileComplete: boolean;
}) {
  const router = useRouter();
  const [pausing, setPausing] = useState(false);

  const connectedCount = connections.filter((c) => c.connection_status === "connected").length;
  const anyActive = settings.some((s) => s.automation_active);

  async function togglePauseAll() {
    if (anyActive) {
      if (!confirm('Pause social automation?\n\nThis will stop scheduled publishing and automated social interactions. Your connected accounts will remain connected.')) return;
    }
    setPausing(true);
    try {
      await fetch("/api/social/automation/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: !anyActive }),
      });
      router.refresh();
    } finally {
      setPausing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="type-display text-ink">Social Media Automation</h1>
        <p className="mt-1 type-body text-ink-secondary">
          Connect your social accounts and let AI create, publish and manage your content automatically.
        </p>
      </div>

      <Suspense>
        <ConnectionBanner />
      </Suspense>

      {!profileComplete && (
        <div className="panel panel-body flex items-center justify-between gap-4">
          <p className="type-caption text-ink-secondary">
            Complete your Business Profile to improve AI-generated content.
          </p>
          <Link
            href="/settings/business-profile"
            className="shrink-0 rounded-md border border-strong px-3 py-1.5 type-caption font-semibold text-ink-secondary hover:bg-sunken"
          >
            Complete Business Profile
          </Link>
        </div>
      )}

      <div className="panel panel-body flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-8">
          <div>
            <p className="type-micro text-ink-tertiary">Connected Accounts</p>
            <p className="num mt-1 text-lg text-ink">{connectedCount}/5</p>
          </div>
          <div>
            <p className="type-micro text-ink-tertiary">Automation Status</p>
            <p className="mt-1">
              <span className={`badge-base ${anyActive ? "badge-positive" : "badge-neutral"}`}>
                {anyActive ? "Automation Active" : "Not configured"}
              </span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="type-caption text-ink-secondary">Social Automation</span>
          <button
            role="switch"
            aria-checked={anyActive}
            onClick={togglePauseAll}
            disabled={pausing || connectedCount === 0}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
              anyActive ? "bg-primary" : "bg-sunken"
            }`}
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-raised shadow-panel transition-transform ${
                anyActive ? "translate-x-5.5 left-0.5" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLATFORMS.map((platform) => (
          <PlatformCard
            key={platform}
            platform={platform}
            connection={connections.find((c) => c.platform === platform) ?? null}
            settings={settings.find((s) => s.platform === platform) ?? null}
            profileComplete={profileComplete}
            onChanged={() => router.refresh()}
          />
        ))}
      </div>

      <p className="type-caption text-ink-tertiary">
        Available features depend on the connected platform and its API permissions.
      </p>
    </div>
  );
}
