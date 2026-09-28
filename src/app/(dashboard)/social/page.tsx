import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { isBusinessProfileComplete } from "@/lib/business-profile";
import type { SocialConnection, SocialAutomationSettings } from "@/types/social";
import SocialPageClient from "@/components/social/social-page-client";

export default async function SocialPage() {
  const supabase = await createClient();
  const { client } = await getCurrentClient();

  const [{ data: connections }, { data: settings, error: settingsError }, { data: profile }] = await Promise.all([
    supabase.from("social_connections").select("*").returns<SocialConnection[]>(),
    supabase.from("social_automation_settings").select("*").returns<SocialAutomationSettings[]>(),
    supabase.from("client_social_profile").select("*").maybeSingle(),
  ]);

  const profileComplete = isBusinessProfileComplete(client, profile);

  return (
    <div className="space-y-6">
      {settingsError && (
        <p className="panel panel-body type-caption text-caution">
          Automation settings aren&apos;t available yet — run{" "}
          <code>supabase/add_social_automation_settings.sql</code> to enable configuration.
        </p>
      )}
      {/* Post creation lives on the Content page, but this is the page where the
          client sets up their voice and preferences — so the way there has to be
          obvious from here, not something they have to go hunting for. */}
      <div className="panel panel-body flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Write and publish a post</p>
          <p className="type-caption text-ink-tertiary">
            Post creation is on the Content page — write it yourself, or press{" "}
            <strong>Generate with AI</strong> to draft the caption, hashtags and image from the profile
            and preferences saved here.
          </p>
        </div>
        <Link
          href="/content"
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Create a post →
        </Link>
      </div>

      <SocialPageClient
        connections={connections ?? []}
        settings={settings ?? []}
        profileComplete={profileComplete}
      />
    </div>
  );
}
