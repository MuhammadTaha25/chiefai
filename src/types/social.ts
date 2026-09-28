export type SocialPlatform = "instagram" | "facebook" | "linkedin" | "tiktok" | "youtube";

export interface SocialConnection {
  id: string;
  client_id: string;
  platform: string;
  zernio_account_id: string | null;
  zernio_profile_id: string | null;
  connection_status: string | null;
  connected_at: string | null;
  inbox_enabled: boolean | null;
  inbox_checked_at: string | null;
}

export interface SocialAutomationSettings {
  id: string;
  client_id: string;
  platform: string;
  posts_per_week: number;
  image_posts_per_week: number;
  carousel_posts_per_week: number;
  video_posts_per_week: number;
  stories_per_week: number;
  content_preference: "ai_full" | "ai_draft" | "user_assisted";
  approval_mode: "full_automation" | "approval_required" | "draft_only";
  publish_mode: "immediate" | "schedule" | "approval_required";
  auto_create_enabled: boolean;
  auto_publish_enabled: boolean;
  stories_enabled: boolean;
  dm_enabled: boolean;
  human_handoff_enabled: boolean;
  comment_enabled: boolean;
  lead_detection_enabled: boolean;
  analytics_enabled: boolean;
  automation_active: boolean;
  activated_at: string | null;
  paused_at: string | null;
  post_time: string | null;
  timezone: string | null;
}

export const PLATFORM_META: Record<
  SocialPlatform,
  { label: string; description: string; supportLevel: "supported" | "coming_soon"; connKey: string }
> = {
  instagram: {
    label: "Instagram",
    description: "Connect your Instagram Business account to automatically create, schedule and publish content.",
    supportLevel: "supported",
    connKey: "instagram",
  },
  facebook: {
    label: "Facebook",
    description: "Connect your Facebook Page to publish content and manage comments alongside Instagram.",
    supportLevel: "supported",
    connKey: "facebook",
  },
  linkedin: {
    label: "LinkedIn",
    description: "Publish company updates and manage engagement on LinkedIn.",
    supportLevel: "coming_soon",
    connKey: "linkedin",
  },
  tiktok: {
    label: "TikTok",
    description: "Automatically create and publish short-form video content.",
    supportLevel: "coming_soon",
    connKey: "tiktok",
  },
  youtube: {
    label: "YouTube",
    description: "Publish videos and Shorts, and track performance.",
    supportLevel: "coming_soon",
    connKey: "youtube",
  },
};
