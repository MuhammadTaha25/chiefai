import { createClient } from "@/lib/supabase/server";
import { getWorkspaceActivity } from "@/lib/workspace-data";
import { ActivityView } from "@/components/workspace/ActivityView";

export default async function ActivityPage() {
  const supabase = await createClient();
  const events = await getWorkspaceActivity(supabase, 50);
  return <ActivityView events={events} />;
}
