"use client";

import { useMemo, useState } from "react";
import type { SocialPost } from "@/types/db";

interface EditModalProps {
  post: SocialPost;
  onClose: () => void;
  onSaved: (updated: SocialPost) => void;
}

function EditModal({ post, onClose, onSaved }: EditModalProps) {
  const [caption, setCaption] = useState(post.caption ?? post.topic ?? "");
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveOnly() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/social/posts/${post.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      onSaved({ ...post, caption });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveAndPublish() {
    setPublishing(true);
    setError(null);
    try {
      // First update caption
      const patchRes = await fetch(`/api/social/posts/${post.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption }),
      });
      const patchData = await patchRes.json();
      if (!patchRes.ok) throw new Error(patchData.error || "Save failed");

      // Then publish
      const pubRes = await fetch("/api/social/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: post.platform,
          content_type: post.content_type,
          caption,
          media_url: post.media_url,
          publish_now: true,
          existing_post_id: post.id,
        }),
      });
      const pubData = await pubRes.json();
      if (!pubRes.ok) throw new Error(pubData.error || "Publish failed");

      onSaved({ ...post, caption, status: "published" });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-black/[.08] px-5 py-4 dark:border-white/[.1]">
          <h2 className="text-sm font-semibold">Edit post</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">✕</button>
        </div>
        <div className="p-5 space-y-4">
          {post.media_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.media_url} alt="" className="h-48 w-full rounded-lg object-cover" />
          )}
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1">Caption</label>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-black/[.1] bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-white/[.15] dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-black/[.1] px-4 py-2 text-sm dark:border-white/[.145]"
            >
              Cancel
            </button>
            <button
              onClick={saveOnly}
              disabled={saving || publishing}
              className="rounded-md border border-black/[.1] px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-zinc-800"
            >
              {saving ? "Saving…" : "Save draft"}
            </button>
            <button
              onClick={saveAndPublish}
              disabled={saving || publishing}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {publishing ? "Publishing…" : "Save & Publish"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ContentGrid({ posts: initialPosts }: { posts: SocialPost[] }) {
  const [posts, setPosts] = useState(initialPosts);
  const [platform, setPlatform] = useState("all");
  const [status, setStatus] = useState("all");
  const [editPost, setEditPost] = useState<SocialPost | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishErrors, setPublishErrors] = useState<Record<string, string>>({});

  const platforms = useMemo(
    () => ["all", ...Array.from(new Set(posts.map((p) => p.platform)))],
    [posts]
  );
  const statuses = useMemo(
    () => ["all", ...Array.from(new Set(posts.map((p) => p.status).filter(Boolean) as string[]))],
    [posts]
  );

  const filtered = posts.filter(
    (p) => (platform === "all" || p.platform === platform) && (status === "all" || p.status === status)
  );

  async function publishDraft(post: SocialPost) {
    setPublishingId(post.id);
    setPublishErrors((prev) => { const next = { ...prev }; delete next[post.id]; return next; });
    try {
      const res = await fetch("/api/social/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: post.platform,
          content_type: post.content_type,
          caption: post.caption ?? post.topic ?? "",
          media_url: post.media_url,
          publish_now: true,
          existing_post_id: post.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Publish failed");
      setPosts((prev) => prev.map((p) => p.id === post.id ? { ...p, status: "published" } : p));
    } catch (e) {
      setPublishErrors((prev) => ({ ...prev, [post.id]: (e as Error).message }));
    } finally {
      setPublishingId(null);
    }
  }

  function onSaved(updated: SocialPost) {
    setPosts((prev) => prev.map((p) => p.id === updated.id ? updated : p));
  }

  return (
    <div>
      {editPost && (
        <EditModal post={editPost} onClose={() => setEditPost(null)} onSaved={onSaved} />
      )}

      <div className="flex flex-wrap gap-3">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="rounded-md border border-black/[.1] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-transparent"
        >
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p === "all" ? "All platforms" : p}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-black/[.1] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-transparent"
        >
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {filtered.map((post) => (
          <div key={post.id} className="overflow-hidden rounded-xl border border-black/[.08] dark:border-white/[.145]">
            {post.media_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={post.media_url} alt="" className="h-40 w-full object-cover" />
            ) : (
              <div className="flex h-40 items-center justify-center bg-zinc-100 text-xs text-zinc-400 dark:bg-zinc-900">
                No preview
              </div>
            )}
            <div className="p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium capitalize text-zinc-500">{post.platform}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${
                  post.status === "published"
                    ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                    : post.status === "scheduled"
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                }`}>
                  {post.status || "draft"}
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-sm">{post.caption || post.topic || "—"}</p>
              {post.status === "scheduled" && post.scheduled_for && (
                <p className="mt-1 text-[10px] text-blue-600 dark:text-blue-400">
                  Scheduled: {new Date(post.scheduled_for).toLocaleString()}
                </p>
              )}

              {post.status !== "published" && (
                <div className="mt-3 space-y-1">
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditPost(post)}
                      className="flex-1 rounded-md border border-black/[.1] py-1 text-xs font-medium hover:bg-zinc-50 dark:border-white/[.145] dark:hover:bg-zinc-800"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => publishDraft(post)}
                      disabled={publishingId === post.id}
                      className="flex-1 rounded-md bg-zinc-900 py-1 text-xs font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      {publishingId === post.id ? "Publishing…" : "Publish"}
                    </button>
                  </div>
                  {publishErrors[post.id] && (
                    <p className="text-[10px] leading-tight text-red-600 dark:text-red-400">{publishErrors[post.id]}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="col-span-full py-8 text-center text-sm text-zinc-500">No posts yet.</p>
        )}
      </div>
    </div>
  );
}
