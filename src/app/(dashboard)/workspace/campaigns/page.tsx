import { createClient } from "@/lib/supabase/server";
import { getWorkspaceContent } from "@/lib/workspace-data";
import { CampaignsContentView } from "@/components/workspace/CampaignsContentView";

export default async function CampaignsPage() {
  const supabase = await createClient();
  const data = await getWorkspaceContent(supabase);
  return (
    <CampaignsContentView
      items={data.items}
      publishedThisMonth={data.publishedThisMonth}
      draftsAwaiting={data.draftsAwaiting}
      failedThisMonth={data.failedThisMonth}
    />
  );
}
