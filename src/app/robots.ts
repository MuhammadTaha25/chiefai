import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/seo";

const PRIVATE = [
  "/api/",
  "/dashboard",
  "/leads",
  "/pipeline",
  "/ads",
  "/social",
  "/content",
  "/finance",
  "/projects",
  "/settings",
  "/onboarding",
  "/campaigns",
  "/domains",
  "/lead-gen",
  "/phone",
  "/prospecting",
];

const AI_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended"];

export default function robots(): MetadataRoute.Robots {
  const base = getSiteUrl();
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      { userAgent: AI_CRAWLERS, allow: "/", disallow: PRIVATE },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
