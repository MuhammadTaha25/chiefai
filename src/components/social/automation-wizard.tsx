"use client";

import { useState } from "react";
import { SocialPlatform, SocialAutomationSettings, PLATFORM_META } from "@/types/social";
import {
  DAILY_WEEKLY_PLAN,
  RECOMMENDED_PLAN,
  RECOMMENDED_WEEKLY_PLAN,
  countsFromPlan,
  parseWeeklyPlan,
  planItems,
  type DayPlan,
  type PostFormat,
  type WeeklyPlan,
} from "@/lib/social-schedule";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 30-minute time slots for the whole day, e.g. "00:00", "00:30", …, "23:30". */
const TIME_OPTIONS: { value: string; label: string }[] = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 === 0 ? "00" : "30";
  const hh = String(h).padStart(2, "0");
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return { value: `${hh}:${m}`, label: `${h12}:${m} ${ampm}` };
});

/**
 * Snap an arbitrary "HH:MM" to the nearest valid 30-minute slot.
 * Prevents old DB values like "15:21" from falling through the select options.
 */
function snapToSlot(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec((hhmm ?? "").trim());
  if (!m) return TIME_OPTIONS[0].value;
  const h = Math.min(23, Number(m[1]));
  const min = Number(m[2]) < 15 ? 0 : Number(m[2]) < 45 ? 30 : 0;
  const hAdj = min === 0 && Number(m[2]) >= 45 ? Math.min(23, h + 1) : h;
  return `${String(hAdj).padStart(2, "0")}:${min === 0 ? "00" : "30"}`;
}

const FORMAT_LABEL: Record<PostFormat, string> = {
  none: "Rest",
  image: "Image",
  carousel: "Carousel",
  video: "Video",
};

type PlanChoice = "recommended" | "daily" | "custom";

/** Minutes east of UTC for a timezone at a given moment (DST-aware). */
function offsetMinutes(tz: string, at: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** "12:00" in `from` → "HH:MM" in `to`, for today. */
function convertTime(hhmm: string, from: string, to: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const local = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m) - offsetMinutes(from, now) * 60000;
  const t = new Date(local + offsetMinutes(to, now) * 60000);
  return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : ["Asia/Karachi", "America/New_York", "Europe/London", "Asia/Dubai", "UTC"];
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="list-row items-start">
      <div className="min-w-0">
        <p className="type-caption font-semibold text-ink">{label}</p>
        <p className="mt-0.5 type-caption text-ink-tertiary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-sunken"
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-raised shadow-panel transition-transform ${
            checked ? "translate-x-5.5 left-0.5" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function initialPlan(existing: SocialAutomationSettings | null): WeeklyPlan {
  const saved = parseWeeklyPlan(existing?.weekly_plan);
  if (saved) return saved;
  return RECOMMENDED_WEEKLY_PLAN.map((d) => ({ ...d }));
}

export default function AutomationWizard({
  platform,
  existing,
  onClose,
  onActivated,
}: {
  platform: SocialPlatform;
  existing: SocialAutomationSettings | null;
  onClose: () => void;
  onActivated: () => void;
}) {
  const meta = PLATFORM_META[platform];
  const [plan, setPlan] = useState<WeeklyPlan>(() => initialPlan(existing));
  const [contentPreference, setContentPreference] = useState(existing?.content_preference ?? "ai_full");
  const [approvalMode, setApprovalMode] = useState(existing?.approval_mode ?? "draft_only");
  const [publishMode, setPublishMode] = useState(existing?.publish_mode ?? "approval_required");

  const [autoCreate, setAutoCreate] = useState(existing?.auto_create_enabled ?? true);
  const [autoPublish, setAutoPublish] = useState(existing?.auto_publish_enabled ?? false);
  const [storiesEnabled, setStoriesEnabled] = useState(existing?.stories_enabled ?? true);
  const [dmEnabled, setDmEnabled] = useState(existing?.dm_enabled ?? true);
  const [humanHandoff, setHumanHandoff] = useState(existing?.human_handoff_enabled ?? true);
  const [commentEnabled, setCommentEnabled] = useState(existing?.comment_enabled ?? true);
  const [leadDetection, setLeadDetection] = useState(existing?.lead_detection_enabled ?? true);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(existing?.analytics_enabled ?? true);

  const [postTime, setPostTime] = useState(() => snapToSlot(existing?.post_time ?? RECOMMENDED_PLAN.postTime));
  const [storyTime, setStoryTime] = useState(() => snapToSlot(existing?.story_time ?? RECOMMENDED_PLAN.storyTime));
  const [timezone, setTimezone] = useState(existing?.timezone ?? "");
  const [planChoice, setPlanChoice] = useState<PlanChoice>(existing ? "custom" : "recommended");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tzReady = Boolean(timezone);
  const counts = countsFromPlan(plan);

  function applyPlan(choice: PlanChoice) {
    setPlanChoice(choice);
    if (choice === "recommended") {
      setPlan(RECOMMENDED_WEEKLY_PLAN.map((d) => ({ ...d })));
      setPostTime(RECOMMENDED_PLAN.postTime);
      setStoryTime(RECOMMENDED_PLAN.storyTime);
    } else if (choice === "daily") {
      setPlan(DAILY_WEEKLY_PLAN.map((d) => ({ ...d })));
      setPostTime(RECOMMENDED_PLAN.postTime);
      setStoryTime(RECOMMENDED_PLAN.storyTime);
    }
  }

  /** Any change to a single day turns the plan into a custom one. */
  function setDay(i: number, change: Partial<DayPlan>) {
    setPlanChoice("custom");
    setPlan((p) => p.map((d, idx) => (idx === i ? { ...d, ...change } : d)));
  }

  async function activate() {
    if (!tzReady) {
      setError("Choose your timezone first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/social/automation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          activate: true,
          // The per-day plan is the source of truth; the server derives the count columns from it.
          weekly_plan: storiesEnabled ? plan : plan.map((d) => ({ ...d, story: false })),
          content_preference: contentPreference,
          approval_mode: approvalMode,
          publish_mode: publishMode,
          auto_create_enabled: autoCreate,
          auto_publish_enabled: autoPublish,
          stories_enabled: storiesEnabled,
          dm_enabled: dmEnabled,
          human_handoff_enabled: humanHandoff,
          comment_enabled: commentEnabled,
          lead_detection_enabled: leadDetection,
          analytics_enabled: analyticsEnabled,
          post_time: postTime || null,
          story_time: storyTime || null,
          timezone: timezone || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      onActivated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const previewItems = planItems(plan, postTime, storyTime);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-8" onClick={onClose}>
      <div className="panel float-layer w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div>
            <h3 className="type-subhead text-ink">Configure your {meta.label} automation</h3>
            <p className="mt-0.5 type-caption text-ink-tertiary">
              {meta.label} connected. Now let&apos;s set up how AI runs your social media.
            </p>
          </div>
        </div>

        <div className="panel-body space-y-6">
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 type-caption text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            What runs today: automatic replies to comments and direct messages, and AI-written posts, videos and stories created from your Business Profile on the weekly plan you choose below. They go live only if approval is set to full automation and automatic publishing is on; otherwise they are saved as drafts for you to release. You can also create posts manually from the Content page.
          </p>

          <section>
            <h4 className="type-caption font-semibold text-ink">How often should we post?</h4>
            <div className="mt-2 space-y-2">
              {[
                { v: "recommended" as const, title: "Recommended: 3 posts/week (Tue, Wed, Thu)", note: "Research ke mutabiq sab se achhe din aur time. Lunch par posts, shaam ko stories. Reach aur engagement behtar hone ki umeed hai." },
                { v: "daily" as const, title: "Daily: 7 posts/week", note: "Account roz active dikhta hai, aur zyada mauqe milte hain. Har din naya content banega, reposting nahi." },
                { v: "custom" as const, title: "Custom", note: "Har din ke liye khud chunein: rest, image, carousel ya video, aur story." },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => applyPlan(opt.v)}
                  className={`block w-full rounded-md border px-3 py-2 text-left ${
                    planChoice === opt.v ? "border-primary bg-primary/5" : "border-strong"
                  }`}
                >
                  <span className="block type-caption font-semibold text-ink">{opt.title}</span>
                  <span className="mt-0.5 block type-caption text-ink-tertiary">{opt.note}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4 className="type-caption font-semibold text-ink">Your week</h4>
            <p className="mt-0.5 type-caption text-ink-tertiary">
              Har din ke aage format chunein. Rest ka matlab us din kuch nahi jayega.
            </p>
            <div className="mt-2 space-y-1.5">
              {DAYS.map((d, i) => (
                <div key={d} className="flex items-center justify-between gap-2 tile px-3 py-2">
                  <span className="w-10 type-caption font-semibold text-ink">{d}</span>
                  <select
                    value={plan[i].post}
                    onChange={(e) => setDay(i, { post: e.target.value as PostFormat })}
                    className="flex-1 rounded-md border border-strong bg-raised px-2 py-1 type-caption text-ink"
                  >
                    {(Object.keys(FORMAT_LABEL) as PostFormat[]).map((f) => (
                      <option key={f} value={f}>
                        {FORMAT_LABEL[f]}
                      </option>
                    ))}
                  </select>
                  <label className={`flex items-center gap-1 type-caption ${storiesEnabled ? "text-ink-secondary" : "text-ink-tertiary opacity-50"}`}>
                    <input
                      type="checkbox"
                      disabled={!storiesEnabled}
                      checked={plan[i].story}
                      onChange={(e) => setDay(i, { story: e.target.checked })}
                    />
                    Story
                  </label>
                </div>
              ))}
            </div>
            <p className="mt-2 type-caption text-ink-tertiary">
              Total: {counts.posts} feed posts ({counts.images} image, {counts.carousels} carousel, {counts.videos} video) aur {storiesEnabled ? counts.stories : 0} stories/week
            </p>
          </section>

          <section>
            <h4 className="type-caption font-semibold text-ink">When should we post?</h4>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="type-caption text-ink-secondary">
                Post time
                <select
                  value={postTime}
                  onChange={(e) => {
                    setPlanChoice("custom");
                    setPostTime(e.target.value);
                  }}
                  className="mt-1 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink"
                >
                  {TIME_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="type-caption text-ink-secondary">
                Story time
                <select
                  value={storyTime}
                  onChange={(e) => {
                    setPlanChoice("custom");
                    setStoryTime(e.target.value);
                  }}
                  className="mt-1 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink"
                >
                  {TIME_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 block type-caption text-ink-secondary">
              Your timezone (required)
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="mt-1 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink"
              >
                <option value="">Choose a timezone…</option>
                {timezoneOptions().map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
            {tzReady ? (
              <p className="mt-2 type-caption text-ink-tertiary">
                Posts {postTime} ({timezone}) par jayengi
                {timezone !== "Asia/Karachi" && <> — Pakistan mein {convertTime(postTime, timezone, "Asia/Karachi")}</>}. Stories {storyTime} par.
              </p>
            ) : (
              <p className="mt-2 type-caption text-amber-700 dark:text-amber-300">Timezone chunne ke baad hi activate ho sakta hai.</p>
            )}
            <div className="mt-3 grid grid-cols-7 gap-1">
              {DAYS.map((d, i) => {
                const items = previewItems.filter((it) => it.weekday === i);
                const post = items.find((it) => it.kind === "post");
                const hasStory = items.some((it) => it.kind === "story");
                return (
                  <div key={d} className="tile p-1.5 text-center type-caption">
                    <p className="font-semibold text-ink">{d}</p>
                    {!post && !hasStory && <p className="text-ink-tertiary">rest</p>}
                    {post && <p className="text-ink-secondary">{FORMAT_LABEL[post.format === "story" ? "none" : post.format === "carousel" ? "carousel" : post.format === "video" ? "video" : "image"]}</p>}
                    {hasStory && <p className="text-ink-tertiary">story</p>}
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <h4 className="type-caption font-semibold text-ink">How should your content be created?</h4>
            <div className="mt-2 space-y-1.5">
              {[
                { v: "ai_full", label: "AI creates everything automatically" },
                { v: "ai_draft", label: "AI creates drafts for approval" },
                { v: "user_assisted", label: "I'll provide some content, AI handles the rest" },
              ].map((opt) => (
                <label key={opt.v} className="list-row cursor-pointer">
                  <span className="type-caption text-ink-secondary">{opt.label}</span>
                  <input
                    type="radio"
                    checked={contentPreference === opt.v}
                    onChange={() => setContentPreference(opt.v as typeof contentPreference)}
                  />
                </label>
              ))}
            </div>
          </section>

          <section>
            <h4 className="type-caption font-semibold text-ink">Approval mode</h4>
            <div className="mt-2 space-y-1.5">
              {[
                { v: "full_automation", label: "Full automation — AI creates + publishes automatically" },
                { v: "approval_required", label: "Approval required — you approve before publishing" },
                { v: "draft_only", label: "Draft only — AI creates, you publish manually" },
              ].map((opt) => (
                <label key={opt.v} className="list-row cursor-pointer">
                  <span className="type-caption text-ink-secondary">{opt.label}</span>
                  <input
                    type="radio"
                    checked={approvalMode === opt.v}
                    onChange={() => {
                      setApprovalMode(opt.v as typeof approvalMode);
                      setPublishMode(opt.v === "full_automation" ? "schedule" : "approval_required");
                    }}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h4 className="type-caption font-semibold text-ink">Automation controls</h4>
            <Toggle
              label="Automatic Post Creation"
              description="AI writes and creates your feed posts and videos on the weekly plan above."
              checked={autoCreate}
              onChange={setAutoCreate}
            />
            <Toggle
              label="Automatic Publishing"
              description="Publish automatically. Also needs approval mode set to Full automation; otherwise posts are saved as drafts."
              checked={autoPublish}
              onChange={setAutoPublish}
            />
            <Toggle
              label="Stories"
              description="Create a story for your posts, as a short teaser of the feed post or video."
              checked={storiesEnabled}
              onChange={setStoriesEnabled}
            />
            <Toggle
              label="DM Assistant"
              description="Answer FAQs, capture leads, and route conversations via DM. Availability depends on platform permissions."
              checked={dmEnabled}
              onChange={setDmEnabled}
            />
            <Toggle
              label="Comment Assistant"
              description="Reply to comments, flag sensitive ones for human review."
              checked={commentEnabled}
              onChange={setCommentEnabled}
            />
            <Toggle
              label="Human Handoff"
              description="Notify you automatically when a conversation needs a human."
              checked={humanHandoff}
              onChange={setHumanHandoff}
            />
            <Toggle
              label="Lead Detection"
              description="Create a lead automatically when AI detects buying intent."
              checked={leadDetection}
              onChange={setLeadDetection}
            />
            <Toggle
              label="Analytics"
              description="Track posts, engagement, and top-performing content."
              checked={analyticsEnabled}
              onChange={setAnalyticsEnabled}
            />
          </section>

          <section className="tile p-4">
            <p className="type-caption font-semibold text-ink">You&apos;re ready to automate your social media.</p>
            <ul className="mt-2 space-y-1 type-caption text-ink-secondary">
              <li>{meta.label} ✓</li>
              <li>{counts.posts} posts/week ✓</li>
              {storiesEnabled && <li>{counts.stories} stories/week ✓</li>}
              {autoCreate && <li>AI content creation ✓</li>}
              {autoPublish && <li>Automatic publishing ✓</li>}
              {dmEnabled && <li>DM assistant ✓</li>}
              {commentEnabled && <li>Comment assistant ✓</li>}
            </ul>
          </section>

          {error && <p className="type-caption text-critical">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-md border border-strong px-4 py-2 type-caption font-semibold text-ink-secondary hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              onClick={activate}
              disabled={loading || !tzReady}
              className="flex-1 rounded-md bg-primary px-4 py-2 type-caption font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
            >
              {loading ? "Activating…" : "Activate Automation"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
