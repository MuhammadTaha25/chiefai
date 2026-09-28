import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import LandingForm from "@/components/landing-form";

export default async function PublicLandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();

  const { data: client } = await admin
    .from("clients")
    .select("id, company_name, landing_slug")
    .eq("landing_slug", slug)
    .maybeSingle();

  if (!client) notFound();

  const { data: profile } = await admin
    .from("client_social_profile")
    .select("niche, pain_points, target_audience")
    .eq("client_id", client.id)
    .maybeSingle();

  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-20 text-center">
        <h1 className="type-display text-ink">{client.company_name}</h1>
        {profile?.niche && <p className="mt-3 type-heading text-ink-secondary">{profile.niche}</p>}
        {profile?.pain_points && (
          <p className="mt-4 max-w-xl type-body text-ink-tertiary">{profile.pain_points}</p>
        )}

        <div className="mt-10 w-full max-w-sm panel panel-body">
          <h2 className="type-subhead text-ink">Get in touch</h2>
          <p className="mt-1 type-caption text-ink-tertiary">
            Leave your details and we&apos;ll be in touch shortly.
          </p>
          <LandingForm slug={slug} />
        </div>
      </div>
    </div>
  );
}
