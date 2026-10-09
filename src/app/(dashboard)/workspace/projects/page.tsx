import { createClient } from "@/lib/supabase/server";
import { getWorkspaceProjects } from "@/lib/workspace-data";
import { ProjectsBoardView } from "@/components/workspace/ProjectsBoardView";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const data = await getWorkspaceProjects(supabase);
  return <ProjectsBoardView projects={data.projects} activeCount={data.activeCount} blockedCount={data.blockedCount} totalRevenue={data.totalRevenue} />;
}
