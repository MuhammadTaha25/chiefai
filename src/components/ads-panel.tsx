"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { DynamicForm } from "@/components/form/dynamic-form";
import { ADS_SCHEMA } from "@/lib/form-schema/ads-schema";
import { buildAdsRecommendation } from "@/lib/form-schema/recommendation";
import { FormValues } from "@/lib/form-schema/types";
import { errorsOf, friendlyAdError, validateAdBrief, type AdIssue } from "@/lib/ad-validation";
import type { AdCampaign } from "@/types/db";

interface AdJob {
  id: string;
  platform: string;
  status: string;
  brief: Record<string, unknown> | null;
  audit_status: string | null;
  recommended_action: string | null;
  external_campaign_id?: string | null;
  external_ad_group_id?: string | null;
  external_ad_id?: string | null;
  last_error?: string | null;
  created_at: string;
}
interface SocialConnection {
  platform: string;
  connection_status: string | null;
}

/**
 * What POST /api/ads/[platform] returns: a PAUSED draft plus everything the
 * preview screen needs. Nothing has spent at this point — the ad only goes live
 * when the user calls POST /api/ads/campaigns/[id] {action:"publish"}.
 */
interface LaunchResult {
  status: string;
  live?: boolean;
  requiresPublish?: boolean;
  campaignId?: string;
  campaign?: { id: string; adSetId?: string; adId?: string; creativeId?: string | null };
  creative?: {
    mediaUrl?: string | null;
    mediaType: "video" | "image" | "none";
    aspect?: string;
    headline: string;
    body: string;
    hashtags?: string[];
    description?: string;
    cta: string;
    linkUrl: string;
    campaignName: string;
    adSetName: string;
  };
  previews?: { format: string; src: string }[];
  targeting?: {
    location: string;
    countries?: string[];
    ageMin: number;
    ageMax: number;
    gender: string;
    interests?: { id: string; name: string }[];
  };
  budget?: { amount: number; currency: string | null; level: string };
  objective?: string;
  reach?: { lower?: number | null; upper?: number | null } | null;
  notes?: string[];
  warning?: string;
  warnings?: string[];
  adjustments?: { what: string; original: string; adjusted: string; reason: string }[];
  resolution?: { kind: string; requested: string; resolvedName: string | null; status: string; note?: string }[];
  aida?: { attention: string; interest: string; desire: string; action: string };
  strategy?: { audience_summary: string; creative_angle: string; focus_applied: string };
  validation?: { checks: { key: string; pass: boolean; note: string }[]; unsupported_claims: string[]; ai_unavailable?: boolean };
  creativeFallback?: string | null;
  requestedFormat?: string;
  version?: number;
  metaChecks?: { key: string; ok: boolean; expected: string; actual: string }[];
  adsManagerUrl?: string;
}

// All three platforms connect through Zernio's OAuth flow (organic social
// and ads use different Zernio endpoints under the hood — see
// /api/zernio/connect — but the app-side pattern is identical for all three).
// connKey uses the *_ads platform values, not the bare "facebook"/"instagram"
// ones — those are the organic social connections and must stay separate
// rows, otherwise connecting Ads here overwrites the organic connection.
const PLATFORMS = [
  { key: "google_ads", label: "Google Ads", connKey: "google_ads" },
  { key: "meta_ads", label: "Facebook Ads", connKey: "facebook_ads" },
  { key: "instagram_ads", label: "Instagram Ads", connKey: "instagram_ads" },
];

interface PaymentGuidance {
  title: string;
  steps: string[];
  link: string;
}

/** Meta preview formats → the label a human recognises. */
const PREVIEW_LABELS: Record<string, string> = {
  MOBILE_FEED_STANDARD: "Facebook feed (mobile)",
  DESKTOP_FEED_STANDARD: "Facebook feed (desktop)",
  INSTAGRAM_STANDARD: "Instagram feed",
  INSTAGRAM_STORY: "Instagram story",
  INSTAGRAM_REELS: "Instagram Reels",
  FACEBOOK_STORY_MOBILE: "Facebook story",
};

/** Publish or discard one reviewed draft, from anywhere in the panel. */
function useDraftAction(campaignId: string, onDone: () => void) {
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [pendingReview, setPendingReview] = useState(false);

  async function act(action: "publish" | "discard") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/ads/campaigns/${campaignId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      if (action === "publish") {
        setPendingReview(Boolean(data.pendingReview));
        setPublished(true);
      } else onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return { act, busy, error, published, pendingReview };
}

function PublishButtons({
  campaignId,
  onDone,
  compact = false,
}: {
  campaignId: string;
  onDone: () => void;
  compact?: boolean;
}) {
  const { act, busy, error, published, pendingReview } = useDraftAction(campaignId, onDone);
  if (published) {
    return (
      <p className="text-green-700 dark:text-green-400">
        {pendingReview
          ? "Submitted to Meta — status: PENDING REVIEW. It only starts spending once Meta approves it."
          : "Published — Meta reports it as active."}
      </p>
    );
  }
  return (
    <div className={compact ? "mt-2" : "flex gap-2 pt-1"}>
      <div className={compact ? "flex gap-2" : "flex flex-1 gap-2"}>
        <button
          type="button"
          onClick={() => act("publish")}
          disabled={busy !== null}
          className={`rounded-md bg-foreground px-3 font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc] ${
            compact ? "py-1 text-xs" : "flex-1 py-2 text-sm"
          }`}
        >
          {busy === "publish" ? "Publishing…" : "Publish now"}
        </button>
        <button
          type="button"
          onClick={() => act("discard")}
          disabled={busy !== null}
          className={`rounded-md border border-zinc-200 px-3 font-medium disabled:opacity-50 dark:border-zinc-800 ${
            compact ? "py-1 text-xs" : "py-2 text-sm"
          }`}
        >
          {busy === "discard" ? "Discarding…" : "Discard"}
        </button>
      </div>
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </div>
  );
}

/**
 * The review screen: the real creative, the real copy, the real targeting and
 * budget, and Meta's OWN placement renderings — all from a draft that has not
 * spent anything. Publish turns it on; Discard deletes it on Meta.
 */
function PreviewPanel({
  result,
  onDone,
  onRegenerate,
  regenerating,
}: {
  result: LaunchResult;
  onDone: () => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  const c = result.creative;

  return (
    <div className="mt-3 space-y-4 rounded-lg border border-zinc-200 p-4 text-xs dark:border-zinc-800">
      <div>
        <p className="font-medium text-amber-700 dark:text-amber-400">
          Draft{result.version && result.version > 1 ? ` (version ${result.version})` : ""} ready — nothing has been spent yet.
        </p>
        <p className="mt-1 text-zinc-500">
          This is exactly what Meta will run. Review it, then publish to make it live.
        </p>
      </div>

      {result.creativeFallback && (
        <p className="rounded-md bg-amber-50 p-2 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
          You chose {result.requestedFormat}, but the video could not be generated, so an image was created instead. Review it before publishing.
        </p>
      )}

      {c?.mediaUrl ? (
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          {c.mediaType === "video" ? (
            <video src={c.mediaUrl} controls className="w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.mediaUrl} alt="Generated ad creative" className="w-full" />
          )}
        </div>
      ) : (
        <p className="rounded-md bg-amber-50 p-2 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
          No media was attached to this ad — add one in Meta Ads Manager before publishing.
        </p>
      )}

      {c && (
        <div className="space-y-1 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
          <p className="text-zinc-500">Primary text</p>
          <p className="font-medium">{c.body}</p>
          {c.hashtags && c.hashtags.length > 0 && (
            <p className="mt-1 text-blue-600 dark:text-blue-400">{c.hashtags.map((h) => `#${h}`).join(" ")}</p>
          )}
          <p className="mt-2 text-zinc-500">Headline</p>
          <p className="font-medium">{c.headline}</p>
          {c.description && (
            <>
              <p className="mt-2 text-zinc-500">Description</p>
              <p>{c.description}</p>
            </>
          )}
          <p className="mt-2 text-zinc-500">
            Button: <span className="font-medium text-foreground">{c.cta.replace(/_/g, " ")}</span> → {c.linkUrl}
          </p>
        </div>
      )}

      {result.aida && (
        <div className="space-y-1 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
          <p className="font-medium">AIDA — how this ad persuades</p>
          {(["attention", "interest", "desire", "action"] as const).map((k) => (
            <p key={k}>
              <span className="font-medium capitalize">{k}:</span> <span className="text-zinc-600 dark:text-zinc-400">{result.aida?.[k] || "—"}</span>
            </p>
          ))}
          {result.strategy?.creative_angle && (
            <p className="pt-1 text-zinc-500">
              Angle: {result.strategy.creative_angle}
              {result.strategy.focus_applied ? ` — ${result.strategy.focus_applied}` : ""}
            </p>
          )}
        </div>
      )}

      {result.adjustments && result.adjustments.length > 0 && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-800 dark:text-amber-300">Adjusted by the system — review before publishing</p>
          {result.adjustments.map((a, i) => (
            <div key={i} className="text-amber-800 dark:text-amber-300">
              <p className="font-medium">{a.what}</p>
              <p>Was: {a.original}</p>
              <p>Now: {a.adjusted}</p>
              <p className="text-amber-700/80 dark:text-amber-400/80">Why: {a.reason}</p>
            </div>
          ))}
          <p className="text-amber-700 dark:text-amber-400">Publish to accept these changes, or Discard to change your brief.</p>
        </div>
      )}

      {result.resolution && result.resolution.some((r) => r.status !== "resolved" || r.note) && (
        <div className="space-y-0.5 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
          <p className="font-medium">Location &amp; interest matching</p>
          {result.resolution
            .filter((r) => r.status !== "resolved" || r.note)
            .map((r, i) => (
              <p key={i} className="text-zinc-600 dark:text-zinc-400">
                {r.kind} “{r.requested}” → {r.resolvedName ?? "not found"} ({r.status.replace(/_/g, " ")}){r.note ? ` — ${r.note}` : ""}
              </p>
            ))}
        </div>
      )}

      {result.metaChecks && result.metaChecks.length > 0 && (
        <div className="space-y-0.5 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
          <p className="font-medium">Checked on Meta (read back from Facebook)</p>
          {result.metaChecks.map((ck) => (
            <p key={ck.key} className={ck.ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>
              {ck.ok ? "✓" : "⚠"} {ck.key} — asked: {ck.expected} · Meta has: {ck.actual}
            </p>
          ))}
          {result.adsManagerUrl && (
            <a href={result.adsManagerUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block underline">
              Open this draft in Facebook Ads Manager
            </a>
          )}
        </div>
      )}

      {result.validation && (
        <div className="space-y-0.5 rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
          <p className="font-medium">AI review of this ad</p>
          {result.validation.checks.map((ck) => (
            <p key={ck.key} className={ck.pass ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>
              {ck.pass ? "✓" : "⚠"} {ck.key.replace(/_/g, " ")} — {ck.note}
            </p>
          ))}
        </div>
      )}

      {result.warnings && result.warnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-800 dark:text-amber-300">Warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-amber-700 dark:text-amber-400">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-0.5 text-zinc-500">
        {result.targeting && (
          <>
            <div className="flex justify-between gap-3">
              <span>Location</span>
              <span className="text-right">{result.targeting.location}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Age / gender</span>
              <span>
                {result.targeting.ageMin}–{result.targeting.ageMax} · {result.targeting.gender}
              </span>
            </div>
            {result.targeting.interests && result.targeting.interests.length > 0 && (
              <div className="flex justify-between gap-3">
                <span>Interests</span>
                <span className="text-right">{result.targeting.interests.map((i) => i.name).join(", ")}</span>
              </div>
            )}
          </>
        )}
        {result.budget && (
          <div className="flex justify-between gap-3">
            <span>Daily budget</span>
            <span>
              {result.budget.amount.toLocaleString()} {result.budget.currency ?? ""}
            </span>
          </div>
        )}
        {result.reach?.upper != null && (
          <div className="flex justify-between gap-3">
            <span>Audience</span>
            <span>
              {result.reach.lower?.toLocaleString()}–{result.reach.upper.toLocaleString()} people
            </span>
          </div>
        )}
      </div>

      {result.previews && result.previews.length > 0 && (
        <div>
          <p className="mb-2 font-medium">How Meta will render it</p>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {result.previews.map((p) => (
              <div key={p.format} className="w-56 shrink-0">
                <p className="mb-1 text-[10px] text-zinc-500">{PREVIEW_LABELS[p.format] ?? p.format}</p>
                <iframe
                  src={p.src}
                  title={p.format}
                  className="h-96 w-56 rounded-md border border-zinc-200 dark:border-zinc-800"
                  // Meta's preview iframes need scripts to render; the sandbox
                  // stops them reaching the parent page.
                  sandbox="allow-scripts allow-same-origin allow-popups"
                  loading="lazy"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {result.notes && result.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-zinc-500">
          {result.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {result.warning && <p className="text-amber-700 dark:text-amber-400">{result.warning}</p>}

      {result.campaignId && <PublishButtons campaignId={result.campaignId} onDone={onDone} />}
      {onRegenerate && (
        <div>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-zinc-800"
          >
            {regenerating ? "Generating a new version…" : "Regenerate creative (keeps this version)"}
          </button>
          <p className="mt-1 text-[10px] text-zinc-500">
            Creates a NEW paused draft with fresh copy and media. This version stays in the campaign list, so you choose which one to publish and discard the other.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Reopens an existing campaign's brief, pre-filled, so the user can change the
 * copy, targeting or creative (including swapping in a new upload) and submit
 * it as a new paused draft version — same regenerate_of path "Regenerate
 * creative" already uses, except the user can actually edit the answers first.
 *
 * This never touches the original campaign on Meta: a live ad keeps running
 * and spending until the user publishes the new draft and discards the old
 * one themselves (there is no proven Meta "update creative on a live ad" call
 * in this codebase, so editing always goes through a fresh reviewable draft
 * instead of guessing at one).
 */
function EditCampaignForm({
  campaign,
  platform,
  platformLabel,
  onDone,
}: {
  campaign: AdCampaign;
  platform: string;
  platformLabel: string;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<AdIssue[]>([]);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const rawBrief = (campaign.launch_payload?.raw_brief as FormValues | undefined) ?? {};

  async function handleSubmit(values: FormValues) {
    setError(null);
    setIssues([]);
    const local = validateAdBrief({ ...values, daily_budget: Number(values.daily_budget) || 0 } as never);
    if (errorsOf(local).length > 0) {
      setIssues(local);
      setError("Fix the problems listed above, then submit again.");
      throw new Error("Fix the problems listed above, then submit again.");
    }
    const res = await fetch(`/api/ads/${platform}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, daily_budget: Number(values.daily_budget) || 0, regenerate_of: campaign.id }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (Array.isArray(data.issues)) setIssues(data.issues);
      setError(data.error || "Failed to submit the edited brief");
      throw new Error(data.error || "Failed to submit the edited brief");
    }
    setResult(data as LaunchResult);
  }

  if (result) {
    return (
      <div className="mt-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <PreviewPanel result={result} onDone={onDone} />
        <button
          type="button"
          onClick={onDone}
          className="mt-3 w-full rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium dark:border-zinc-800"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="mb-3 text-xs text-zinc-500">
        Editing creates a NEW paused draft with your changes — the original campaign is untouched (if it&apos;s live, it
        keeps running and spending until you publish this draft and discard the old one yourself).
      </p>
      {error && <p className="mb-3 text-xs text-red-600">{error}</p>}
      {issues.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-md border border-red-200 bg-red-50 p-3 text-xs dark:border-red-900 dark:bg-red-950">
          {issues.map((i, n) => (
            <li key={n} className={i.severity === "error" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-400"}>
              {i.severity === "error" ? "✕" : "⚠"} {i.message}
            </li>
          ))}
        </ul>
      )}
      <DynamicForm
        sections={ADS_SCHEMA}
        title="Change whatever you need, then submit to build the new version."
        buildRecommendation={buildAdsRecommendation}
        onSubmit={handleSubmit}
        submitLabel="Save as new draft"
        formId={`ads-edit-${campaign.id}`}
        initialValues={rawBrief}
        initialReviewing
        reviewTitle="Here's the updated ad"
        reviewNote={`Review your changes below. On submit we rebuild the campaign, ad set and ad on ${platformLabel} as a NEW paused draft — nothing is spent until you publish it.`}
      />
      <button
        type="button"
        onClick={onDone}
        className="mt-4 w-full rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium dark:border-zinc-800"
      >
        Cancel
      </button>
    </div>
  );
}

function BriefForm({
  platform,
  platformLabel,
  onSubmitted,
}: {
  platform: string;
  platformLabel: string;
  onSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<PaymentGuidance | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [issues, setIssues] = useState<AdIssue[]>([]);
  const [lastValues, setLastValues] = useState<FormValues | null>(null);
  const [approval, setApproval] = useState<{ what: string; original: string; adjusted: string; reason: string }[] | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  async function handleSubmit(values: FormValues, extra: Record<string, unknown> = {}) {
    setLastValues(values);
    setApproval(null);
    setError(null);
    setGuidance(null);
    setIssues([]);
    // Same validator the server runs — catches contradictions and unsupported
    // options instantly, before any AI or Meta work starts.
    const local = validateAdBrief({ ...values, daily_budget: Number(values.daily_budget) || 0 } as never);
    if (errorsOf(local).length > 0) {
      setIssues(local);
      setError("Fix the problems listed above, then submit again.");
      throw new Error("Fix the problems listed above, then submit again.");
    }
    const res = await fetch(`/api/ads/${platform}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, daily_budget: Number(values.daily_budget) || 0, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.code === "needs_adjustment_approval") setApproval(data.adjustments ?? []);
      if (Array.isArray(data.issues)) setIssues(data.issues);
      setError(data.error || "Failed to submit brief");
      if (data.guidance) setGuidance(data.guidance);
      throw new Error(data.error || "Failed to submit brief");
    }
    // The ad is built as a PAUSED draft with Meta's own previews — nothing has
    // spent yet. The preview panel is what the user reviews and publishes.
    setResult(data as LaunchResult);
    onSubmitted();
  }

  async function regenerate() {
    if (!lastValues || !result?.campaignId) return;
    setRegenerating(true);
    try {
      await handleSubmit(lastValues, { regenerate_of: result.campaignId });
    } catch {
      // handleSubmit already recorded the error; keep showing the current version.
    } finally {
      setRegenerating(false);
    }
  }

  if (result) {
    return (
      <>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        <PreviewPanel result={result} onDone={() => setResult(null)} onRegenerate={regenerate} regenerating={regenerating} />
      </>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        New ad brief
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      {error && !guidance && <p className="mb-3 text-xs text-red-600">{error}</p>}
      {approval && (
        <div className="mb-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-800 dark:text-amber-300">Approve broader targeting?</p>
          {approval.map((a, i) => (
            <div key={i} className="text-amber-800 dark:text-amber-300">
              <p className="font-medium">{a.what}</p>
              <p>Was: {a.original}</p>
              <p>Now: {a.adjusted}</p>
              <p>Why: {a.reason}</p>
            </div>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={regenerating}
              onClick={async () => {
                if (!lastValues) return;
                setRegenerating(true);
                try {
                  await handleSubmit(lastValues, { accept_adjustments: true });
                } catch {
                  /* error already shown */
                } finally {
                  setRegenerating(false);
                }
              }}
              className="flex-1 rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {regenerating ? "Building draft…" : "Approve & build draft"}
            </button>
            <button type="button" onClick={() => setApproval(null)} className="rounded-md border border-amber-400 px-3 py-1.5 font-medium">
              Change my brief
            </button>
          </div>
        </div>
      )}
      {issues.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-md border border-red-200 bg-red-50 p-3 text-xs dark:border-red-900 dark:bg-red-950">
          {issues.map((i, n) => (
            <li key={n} className={i.severity === "error" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-400"}>
              {i.severity === "error" ? "✕" : "⚠"} {i.message}
            </li>
          ))}
        </ul>
      )}
      {guidance && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-800 dark:text-amber-300">{guidance.title}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-amber-700 dark:text-amber-400">
            {guidance.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <a
            href={guidance.link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
          >
            Open Meta billing settings
          </a>
        </div>
      )}
      <DynamicForm
        sections={ADS_SCHEMA}
        title="Answer in plain English — no marketing jargon needed."
        buildRecommendation={buildAdsRecommendation}
        onSubmit={handleSubmit}
        submitLabel="Build draft & preview"
        // Without this the Ads form shared its sessionStorage draft key with
        // the lead-gen form ("default"), so answers typed in one form could
        // reappear in the other.
        formId={`ads-${platform}`}
        reviewTitle="Here's the ad we'll build"
        reviewNote={`Review the plan below. On submit we write the copy, generate the creative and build the campaign, ad set and ad on ${platformLabel} as a PAUSED draft — nothing is spent. You then see the preview and press Publish to make it live.`}
      />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-4 w-full rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium dark:border-zinc-800"
      >
        Cancel
      </button>
    </div>
  );
}

export default function AdsPanel({
  jobs,
  connections,
  googleAdsCustomerId,
  campaigns = [],
}: {
  jobs: AdJob[];
  connections: SocialConnection[];
  googleAdsCustomerId: string | null;
  /** ad_campaigns rows — both live campaigns and unpublished drafts. */
  campaigns?: AdCampaign[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const zernioError = searchParams.get("zernio_error");
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div>
      {zernioError && (
        <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Connection failed: {zernioError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {PLATFORMS.map((p) => {
          const conn = connections.find((c) => c.platform === p.connKey);
          const connected = conn?.connection_status === "connected";
          const platformJobs = jobs.filter((j) => j.platform === p.key);
          const platformCampaigns = campaigns.filter((c) => c.platform === p.key);
          const isGoogle = p.key === "google_ads";

          return (
            <div key={p.key} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{p.label}</h2>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    connected
                      ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                  }`}
                >
                  {connected ? "Connected" : conn?.connection_status === "no_ad_account" ? "No ad account" : "Not connected"}
                </span>
              </div>

              {isGoogle && connected && googleAdsCustomerId && (
                <p className="mt-1 text-xs text-zinc-500">Account {googleAdsCustomerId}</p>
              )}

              {isGoogle ? (
                <p className="mt-3 rounded-md bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-900">
                  Google Ads publishing isn&apos;t supported yet — only Facebook and Instagram ads can be created from here.
                </p>
              ) : connected ? (
                <BriefForm platform={p.key} platformLabel={p.label} onSubmitted={() => router.refresh()} />
              ) : (
                <>
                  {conn?.connection_status === "no_ad_account" && (
                    <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                      Your account is linked, but no Meta ad account is attached to it. Reconnect and tick your Ad Account (and Business) when Facebook asks.
                    </p>
                  )}
                  {conn?.connection_status === "disconnected" && (
                    <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                      This connection no longer exists on the ads provider (it was removed or expired). Connect again to continue.
                    </p>
                  )}
                  <a
                    href={`/api/zernio/connect?platform=${p.connKey}&next=/ads`}
                    className="mt-3 block rounded-md border border-zinc-200 px-3 py-2 text-center text-sm font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                  >
                    {conn ? "Reconnect" : "Connect"} {p.label}
                  </a>
                </>
              )}

              <div className="mt-4 space-y-2">
                {platformJobs.slice(0, 5).map((job) => (
                  <div key={job.id} className="rounded-md bg-zinc-50 p-2.5 text-xs dark:bg-zinc-900">
                    <div className="flex justify-between">
                      <span className="font-medium">{(job.brief?.advertising_what as string) || "Untitled"}</span>
                      <span className="text-zinc-500">
                        {job.status === "error" ? "Failed" : job.status === "completed" ? "Done" : job.status}
                      </span>
                    </div>
                    {job.audit_status && (
                      <p className="mt-1 text-zinc-500">
                        Audit: {job.audit_status}
                        {job.recommended_action ? ` — ${job.recommended_action.replace(/_/g, " ")}` : ""}
                      </p>
                    )}
                    {job.external_campaign_id && (
                      <p className="mt-1 font-mono text-[10px] text-zinc-400">
                        campaign {job.external_campaign_id}
                        {job.external_ad_group_id ? ` · ad set ${job.external_ad_group_id}` : ""}
                        {job.external_ad_id ? ` · ad ${job.external_ad_id}` : ""}
                      </p>
                    )}
                    {job.status === "error" && job.last_error && (
                      <p className="mt-1 text-red-600 dark:text-red-400">{friendlyAdError(job.last_error)}</p>
                    )}
                  </div>
                ))}
                {platformJobs.length > 5 && (
                  <p className="text-[10px] text-zinc-400">{platformJobs.length - 5} older attempt(s) hidden.</p>
                )}
                {platformJobs.length === 0 && (
                  <p className="text-xs text-zinc-500">No ads generated yet.</p>
                )}
              </div>

              {platformCampaigns.some((c) => c.status !== "declined") && (
                <div className="mt-4 space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  <p className="text-xs font-medium text-zinc-500">Campaigns on {p.label}</p>
                  {platformCampaigns.filter((c) => c.status !== "declined").map((c) => {
                    const isDraft = c.status === "paused";
                    const budget = c.launch_payload?.budget as
                      | { amount?: number; currency?: string | null }
                      | undefined;
                    return (
                      <div key={c.id} className="rounded-md border border-zinc-200 p-2.5 text-xs dark:border-zinc-800">
                        <div className="flex justify-between gap-2">
                          <span className="font-medium">{c.campaign_name || "Untitled"}</span>
                          <span
                            className={
                              isDraft
                                ? "text-amber-700 dark:text-amber-400"
                                : c.status === "launched" || c.status === "live"
                                  ? "text-green-700 dark:text-green-400"
                                  : "text-zinc-500"
                            }
                          >
                            {isDraft
                              ? "DRAFT"
                              : c.launch_payload?.pending_review
                                ? "PENDING REVIEW"
                                : c.status === "launched" || c.status === "live"
                                  ? "LIVE"
                                  : c.status.replace(/_/g, " ")}
                          </span>
                        </div>
                        <p className="mt-1 text-zinc-500">
                          {c.daily_budget != null
                            ? `${Number(c.daily_budget).toLocaleString()} ${budget?.currency ?? ""}/day`
                            : "—"}
                          {c.objective ? ` · ${c.objective.replace(/_/g, " ")}` : ""}
                        </p>
                        {(c.ad_set_id || c.ad_id) && (
                          <p className="mt-1 font-mono text-[10px] text-zinc-400">
                            {c.ad_set_id ? `ad set ${c.ad_set_id}` : ""}
                            {c.ad_id ? ` · ad ${c.ad_id}` : ""}
                          </p>
                        )}
                        {/* A draft that was never published stays publishable
                            from here, so navigating away doesn't strand it. */}
                        {isDraft && c.zernio_campaign_id && (
                          <PublishButtons campaignId={c.id} onDone={() => router.refresh()} compact />
                        )}
                        {c.status === "error" && c.error_message && (
                          <p className="mt-1 text-red-600 dark:text-red-400">{friendlyAdError(c.error_message)}</p>
                        )}
                        {c.launch_payload?.warnings?.length ? (
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-amber-700 dark:text-amber-400">
                            {c.launch_payload.warnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        ) : null}
                        {c.launch_payload?.raw_brief && c.status !== "error" && (
                          <button
                            type="button"
                            onClick={() => setEditingId(editingId === c.id ? null : c.id)}
                            className="mt-2 w-full rounded-md border border-zinc-200 py-1 text-[11px] font-medium dark:border-zinc-800"
                          >
                            {editingId === c.id ? "Close edit" : "Edit"}
                          </button>
                        )}
                        {editingId === c.id && (
                          <EditCampaignForm
                            campaign={c}
                            platform={p.key}
                            platformLabel={p.label}
                            onDone={() => {
                              setEditingId(null);
                              router.refresh();
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
