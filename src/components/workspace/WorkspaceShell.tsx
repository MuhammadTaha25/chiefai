"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles } from "lucide-react";
import { AssistantPanel } from "./AssistantPanel";

const TABS = [
  { href: "/workspace/overview", label: "Overview" },
  { href: "/workspace/leads", label: "Leads & pipeline" },
  { href: "/workspace/campaigns", label: "Campaigns & content" },
  { href: "/workspace/projects", label: "Projects" },
  { href: "/workspace/finance", label: "Finance" },
  { href: "/workspace/activity", label: "Activity" },
];

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <div className="ns-root -m-6 min-h-[calc(100vh-56px)] md:-m-8">
      <div className="mx-auto max-w-[1480px] px-6 pt-6 md:px-10">
        <div className="ns-scrollbar mb-6 flex items-center justify-between gap-3 overflow-x-auto">
          <nav className="flex gap-1" aria-label="Executive workspace sections">
            {TABS.map((tab) => {
              const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className="ns-focus shrink-0 rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors"
                  style={
                    active
                      ? { background: "rgba(115,87,255,0.1)", color: "#5B43D6" }
                      : { color: "#667085" }
                  }
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
          <button
            onClick={() => setAssistantOpen(true)}
            className="ns-focus flex shrink-0 items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-semibold text-white"
            style={{ background: "#101828" }}
          >
            <Sparkles className="size-3.5" style={{ color: "#C7F36B" }} aria-hidden />
            Chief of staff
          </button>
        </div>
        <div className="pb-10">{children}</div>
      </div>
      <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}

export default WorkspaceShell;
