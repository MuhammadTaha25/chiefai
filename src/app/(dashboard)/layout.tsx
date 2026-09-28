import { redirect } from "next/navigation";
import { getCurrentClient } from "@/lib/get-current-client";
import AppShell from "@/components/app-shell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, client } = await getCurrentClient();

  if (!user) redirect("/login");
  if (!client) redirect("/onboarding");

  return <AppShell companyName={client.company_name ?? "Infomist"}>{children}</AppShell>;
}
