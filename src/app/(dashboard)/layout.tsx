import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentClient } from "@/lib/get-current-client";
import AppShell from "@/components/app-shell";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, client } = await getCurrentClient();

  if (!user) redirect("/login");
  if (!client) redirect("/onboarding");

  return <AppShell companyName={client.company_name ?? "Executive Workspace"}>{children}</AppShell>;
}
