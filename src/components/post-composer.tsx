"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Compose + publish a post to a connected account.
 *
 * Post creation previously did not exist anywhere in the product — the Content
 * page was read-only and the wizard said "not available yet".
 *
 * The post TYPE is derived, not chosen freely, because that is how the
 * platforms work (Zernio's spec is explicit about it):
 *   Instagram — contentType only accepts "story". Everything else is a feed
 *   post; ONE video becomes a Reel automatically, and 2+ images become a
 *   carousel. Text-only is rejected outright.
 *   Facebook — contentType accepts "story" (24h Page story) or "reel";
 *   omitting it gives a normal feed post.
 * So the user picks an intent and the media decides the concrete result, which
 * is shown back to them before they publish.
 */
type PostType = "feed" | "story" | "reel";
type Upload = { base64: string; mime: string; name: string };

const MAX_MEDIA = 10;

export default function PostComposer({ platforms }: { platforms: string[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [platform, setPlatform] = useState(platforms[0] ?? "");
  const [postType, setPostType] = useState<PostType>("feed");
  const [caption, setCaption] = useState("");
  const [urls, setUrls] = useState<string[]>([]);
  const [urlDraft, setUrlDraft] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [mode, setMode] = useState<"now" | "schedule" | "draft">("draft");
  const [scheduledFor, setScheduledFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const mediaCount = urls.length + uploads.length;
  const instagramTextOnly = platform === "instagram" && postType !== "story" && mediaCount === 0;
  const storyNeedsOne = postType === "story" && mediaCount !== 1;
  const blocked = instagramTextOnly || storyNeedsOne || (!caption.trim() && mediaCount === 0);

  // Mirrors resolvedContentType() on the server, so the user sees the truth
  // before publishing rather than discovering it afterwards.
  const resolved = postType === "story"
    ? "Story (24 hours)"
    : postType === "reel"
      ? "Reel"
      : mediaCount > 1
        ? `Carousel (${mediaCount} images)`
        : mediaCount === 1
          ? (uploads[0]?.mime.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(urls[0] ?? "") ? "Video — posted as a Reel on Instagram" : "Single image post")
          : "Text post";

  async function onPickFiles(files: FileList | null) {
    if (!files?.length) return;
    const next: Upload[] = [];
    for (const f of Array.from(files)) {
      if (f.size > 5 * 1024 * 1024) {
        setResult({ ok: false, text: `${f.name} is larger than 5 MB — use a media URL instead.` });
        continue;
      }
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      next.push({ base64: btoa(bin), mime: f.type || "image/jpeg", name: f.name });
    }
    setUploads((prev) => [...prev, ...next].slice(0, MAX_MEDIA));
    setResult(null);
  }

  async function generateWithAi() {
    setGenerating(true);
    setResult(null);
    try {
      const res = await fetch("/api/social/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          kind: postType === "story" ? "story" : mediaCount > 1 ? "carousel" : "image",
          with_image: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not generate content");
      const idea = data.idea ?? {};
      const tags = (idea.hashtags ?? []).map((h: string) => `#${String(h).replace(/^#/, "")}`).join(" ");
      setCaption([idea.caption, tags].filter(Boolean).join("\n\n"));
      if (data.mediaUrl) setUrls([data.mediaUrl]);
      setUploads([]);
      if (fileRef.current) fileRef.current.value = "";
      setResult({ ok: true, text: "Draft written from your Business Profile — review it, then publish." });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setGenerating(false);
    }
  }

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/social/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          caption,
          post_type: postType,
          ...(urls.length ? { media_urls: urls } : {}),
          ...(uploads.length
            ? { media_uploads: uploads.map((u) => ({ base64: u.base64, mime: u.mime, filename: u.name })) }
            : {}),
          publish_now: mode === "now",
          is_draft: mode === "draft",
          ...(mode === "schedule" && scheduledFor ? { scheduled_for: new Date(scheduledFor).toISOString() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create the post");
      setResult({ ok: true, text: `${data.post?.content_type ?? "post"} ${data.post?.status ?? "created"}.` });
      setCaption(""); setUrls([]); setUploads([]); setUrlDraft("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (platforms.length === 0) {
    return (
      <div className="panel panel-body">
        <p className="text-sm text-zinc-500">
          Connect an Instagram or Facebook account first — there is nowhere to publish yet.
        </p>
      </div>
    );
  }

  return (
    <div className="panel panel-body space-y-4">
      <h2 className="text-lg font-semibold">Create a post</h2>

      <div className="flex flex-wrap items-center gap-3">
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}
          className="rounded-md border border-black/[.1] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-transparent">
          {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select value={postType} onChange={(e) => setPostType(e.target.value as PostType)}
          className="rounded-md border border-black/[.1] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-transparent">
          <option value="feed">Feed post</option>
          <option value="story">Story (24h)</option>
          <option value="reel">Reel</option>
        </select>

        <select value={mode} onChange={(e) => setMode(e.target.value as "now" | "schedule" | "draft")}
          className="rounded-md border border-black/[.1] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-transparent">
          <option value="draft">Save as draft</option>
          <option value="now">Publish now</option>
          <option value="schedule">Schedule</option>
        </select>

        {mode === "schedule" && (
          <input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)}
            className="rounded-md border border-black/[.1] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-transparent" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={generateWithAi}
          disabled={generating}
          className="rounded-md border border-black/[.15] px-4 py-1.5 text-sm font-medium hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.2] dark:hover:bg-white/[.06]"
        >
          {generating ? "Writing…" : "✨ Generate with AI"}
        </button>
        <span className="text-xs text-zinc-500">
          Writes a caption, hashtags and an image from your Business Profile and saved preferences.
        </span>
      </div>

      <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={4} maxLength={2200}
        placeholder="Write your caption…"
        className="w-full rounded-md border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]" />
      <p className="text-xs text-zinc-500">{caption.length}/2200</p>

      <div className="space-y-2">
        <div className="flex gap-2">
          <input value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="Image or video URL (https://…)"
            className="flex-1 rounded-md border border-black/[.1] bg-transparent px-3 py-2 text-sm dark:border-white/[.145]" />
          <button type="button"
            onClick={() => { if (urlDraft.trim()) { setUrls((p) => [...p, urlDraft.trim()].slice(0, MAX_MEDIA)); setUrlDraft(""); } }}
            className="rounded-md border border-black/[.1] px-3 py-1.5 text-sm dark:border-white/[.145]">
            Add
          </button>
        </div>

        {urls.length > 0 && (
          <ul className="space-y-1">
            {urls.map((u, i) => (
              <li key={`${u}-${i}`} className="flex items-center justify-between rounded-md border border-black/[.06] px-2 py-1 text-xs dark:border-white/[.08]">
                <span className="truncate">{u}</span>
                <button type="button" onClick={() => setUrls((p) => p.filter((_, j) => j !== i))} className="ml-2 text-zinc-400 hover:text-zinc-600">✕</button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <input ref={fileRef} type="file" accept="image/*,video/*" multiple onChange={(e) => onPickFiles(e.target.files)}
            className="text-sm" />
          {uploads.length > 0 && <span className="text-xs text-zinc-500">{uploads.length} file(s) selected</span>}
        </div>

        <p className="text-xs text-zinc-500">
          Up to {MAX_MEDIA} items. 2+ images become a carousel; 1 video becomes a Reel on Instagram.
        </p>
      </div>

      <p className="rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
        This will be posted as: <strong>{resolved}</strong>
      </p>

      {instagramTextOnly && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Instagram does not support text-only posts — attach an image or video, or use a Story.
        </p>
      )}
      {storyNeedsOne && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          A Story needs exactly one image or video ({mediaCount} attached).
        </p>
      )}
      {result && (
        <p className={`rounded-md p-3 text-sm ${result.ok
          ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300"
          : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300"}`}>
          {result.text}
        </p>
      )}

      <button onClick={submit} disabled={busy || blocked}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]">
        {busy ? "Working…" : mode === "now" ? "Publish now" : mode === "schedule" ? "Schedule post" : "Save draft"}
      </button>
    </div>
  );
}
