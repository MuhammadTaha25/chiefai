"use client";

import { useState } from "react";
import { SocialPlatform, SocialAutomationSettings, PLATFORM_META } from "@/types/social";
import { weeklyItems } from "@/lib/social-schedule";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const FREQ_OPTIONS = [1, 2, 3, 5, 7, 10];

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
  const [postsPerWeek, setPostsPerWeek] = useState(existing?.posts_per_week ?? 3);
  const [imagePosts, setImagePosts] = useState(existing?.image_posts_per_week ?? 2);
  const [carouselPosts, setCarouselPosts] = useState(existing?.carousel_posts_per_week ?? 1);
  const [videoPosts, setVideoPosts] = useState(existing?.video_posts_per_week ?? 0);
  const [storiesPerWeek, setStoriesPerWeek] = useState(existing?.stories_per_week ?? 3);
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

  const [postTime, setPostTime] = useState(existing?.post_time ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/social/automation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          activate: true,
          posts_per_week: postsPerWeek,
          image_posts_per_week: imagePosts,
          carousel_posts_per_week: carouselPosts,
          video_posts_per_week: videoPosts,
          stories_per_week: storiesPerWeek,
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
          // Optional: empty means "use the default time". The timezone is the browser's, saved only with a time.
          post_time: postTime || null,
          timezone: postTime ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
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
            <p className="mt-0.5 type-caption text-ink-tertiary">Recommended: 3–5 posts/week</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {FREQ_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    // The weekly plan is built from the per-format counts below, so keep them adding up to this number.
                    setPostsPerWeek(n);
                    setImagePosts(Math.max(0, n - carouselPosts - videoPosts));
                  }}
                  className={`rounded-full px-3 py-1.5 type-caption font-semibold ${
                    postsPerWeek === n ? "bg-primary text-primary-foreground" : "tile text-ink-secondary"
                  }`}
                >
                  {n}/week
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4 className="type-caption font-semibold text-ink">What should we create?</h4>
            <div className="mt-2 space-y-2">
              {[
                { label: "Image posts", value: imagePosts, set: setImagePosts },
                { label: "Carousel posts", value: carouselPosts, set: setCarouselPosts },
                { label: "Videos/Reels", value: videoPosts, set: setVideoPosts },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between tile px-3 py-2">
                  <span className="type-caption text-ink-secondary">{row.label}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => row.set(Math.max(0, row.value - 1))}
                      className="grid size-6 place-items-center rounded-sm border border-strong text-ink-secondary"
                    >
                      −
                    </button>
                    <span className="num w-4 text-center text-ink">{row.value}</span>
                    <button
                      onClick={() => row.set(row.value + 1)}
                      className="grid size-6 place-items-center rounded-sm border border-strong text-ink-secondary"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 type-caption text-ink-tertiary">
              Total: {imagePosts + carouselPosts + videoPosts} feed posts/week
            </p>
          </section>

          <section>
            <h4 className="type-caption font-semibold text-ink">Stories</h4>
            <p className="mt-0.5 type-caption text-ink-tertiary">How many stories should we publish each week?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {[3, 5, 7, 10, 14].map((n) => (
                <button
                  key={n}
                  onClick={() => setStoriesPerWeek(n)}
                  className={`rounded-full px-3 py-1.5 type-caption font-semibold ${
                    storiesPerWeek === n ? "bg-primary text-primary-foreground" : "tile text-ink-secondary"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4 className="type-caption font-semibold text-ink">When should we post? (optional)</h4>
            <p className="mt-0.5 type-caption text-ink-tertiary">Leave empty and posts go out at 17:00 and stories at 19:00.</p>
            <input
              type="time"
              value={postTime}
              onChange={(e) => setPostTime(e.target.value)}
              className="mt-2 rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink"
            />
            <div className="mt-3 grid grid-cols-7 gap-1">
              {DAYS.map((d, i) => {
                const items = weeklyItems({ images: imagePosts, carousels: carouselPosts, videos: videoPosts, stories: storiesEnabled ? storiesPerWeek : 0, postsPerWeek, postTime }).filter((it) => it.weekday === i);
                const posts = items.filter((it) => it.kind === "post");
                const stories = items.filter((it) => it.kind === "story").length;
                return (
                  <div key={d} className="tile p-1.5 text-center type-caption">
                    <p className="font-semibold text-ink">{d}</p>
                    {posts.length === 0 && stories === 0 && <p className="text-ink-tertiary">rest</p>}
                    {posts.map((it, k) => (
                      <p key={k} className="text-ink-secondary">{it.format === "video" ? "video" : "post"}</p>
                    ))}
                    {stories > 0 && <p className="text-ink-tertiary">{stories} story</p>}
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
              <li>{postsPerWeek} posts/week ✓</li>
              {storiesEnabled && <li>{storiesPerWeek} stories/week ✓</li>}
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
              disabled={loading}
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
