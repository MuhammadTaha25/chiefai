"use client";

import { useMemo, useState } from "react";
import type { SocialPost } from "@/types/db";

export default function ContentGrid({ posts }: { posts: SocialPost[] }) {
  const [platform, setPlatform] = useState("all");
  const [status, setStatus] = useState("all");

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

  return (
    <div>
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
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                  {post.status || "draft"}
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-sm">{post.caption || post.topic || "—"}</p>
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
