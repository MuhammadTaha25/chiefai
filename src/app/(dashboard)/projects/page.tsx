import { createClient } from "@/lib/supabase/server";
import type { Project } from "@/types/db";
import ProjectsBoard from "@/components/projects-board";

export default async function ProjectsPage() {
  const supabase = await createClient();

  const { data: projects } = await supabase
    .from("projects")
    .select("*")
    .order("updated_at", { ascending: false })
    .returns<Project[]>();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <ProjectsBoard projects={projects ?? []} />
    </div>
  );
}
