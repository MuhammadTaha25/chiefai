"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Search as LeadGenIcon,
  KanbanSquare,
  Radar,
  Target,
  Megaphone,
  Sparkles,
  Share2,
  Wallet,
  FolderKanban,
  Plug,
  Globe,
  Phone,
  PanelLeftClose,
  PanelLeft,
  LogOut,
  Search,
  Bell,
  Moon,
  Sun,
  Compass,
  Activity,
  ArrowRight,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Workspace",
    items: [
      { href: "/workspace/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/workspace/leads", label: "Leads & pipeline", icon: Users },
      { href: "/workspace/campaigns", label: "Campaigns & content", icon: Megaphone },
      { href: "/workspace/projects", label: "Projects", icon: FolderKanban },
      { href: "/workspace/finance", label: "Finance", icon: Wallet },
      { href: "/workspace/activity", label: "Activity", icon: Activity },
    ],
  },
  {
    section: "Growth",
    items: [
      { href: "/leads", label: "Leads", icon: Users },
      { href: "/lead-gen", label: "Find leads", icon: LeadGenIcon },
      { href: "/campaigns", label: "Campaigns", icon: Target },
      { href: "/prospecting", label: "AI Prospecting", icon: Radar },
      { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
      { href: "/ads", label: "Ads", icon: Megaphone },
      { href: "/social", label: "Social Media", icon: Share2 },
      { href: "/content", label: "Content", icon: Sparkles },
    ],
  },
  {
    section: "Business",
    items: [
      { href: "/finance", label: "Finance", icon: Wallet },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/phone", label: "Phone", icon: Phone },
      { href: "/domains", label: "Domains", icon: Globe },
      { href: "/settings", label: "Settings", icon: Plug },
    ],
  },
];

const TITLES: Record<string, string> = Object.fromEntries(
  NAV.flatMap((g) => g.items.map((i) => [i.href, i.label]))
);

export default function AppShell({ children, companyName }: { children: ReactNode; companyName: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("infomist-theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate persisted theme after mount (avoids SSR mismatch)
    setDark(stored === "dark");
  }, []);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setUserEmail(data.user?.email ?? null));
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("infomist-theme", dark ? "dark" : "light");
  }, [dark]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const title = TITLES[pathname] ?? "Overview";
  const initials = companyName
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const userInitials = userEmail ? userEmail.slice(0, 2).toUpperCase() : "";

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-hairline bg-raised transition-[width] duration-200 ease-out md:flex ${
          collapsed ? "w-[56px]" : "w-[240px]"
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-hairline px-3">
          <div className="grid size-6 shrink-0 place-items-center rounded-full bg-[#7357FF] text-white">
            <Compass className="size-3.5" />
          </div>
          {!collapsed && <span className="type-subhead truncate text-ink">ChiefAI</span>}
        </div>

        {!collapsed && (
          <div className="border-b border-hairline px-3 py-2.5">
            <button className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-sunken">
              <span className="min-w-0">
                <span className="block truncate text-[0.8125rem] font-medium text-ink">{companyName}</span>
                <span className="block text-[0.6875rem] text-ink-tertiary">Agency workspace</span>
              </span>
            </button>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-2 py-4">
          {NAV.map((group) => (
            <div key={group.section} className="mb-4">
              {!collapsed && <p className="type-micro px-2 pb-2 text-ink-tertiary">{group.section}</p>}
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;
                  return (
                    <li key={item.href} className="relative">
                      {active && !collapsed && (
                        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-[#7357FF]" aria-hidden />
                      )}
                      <Link
                        href={item.href}
                        title={item.label}
                        className={`flex h-9 items-center gap-2 rounded-md px-2 text-[0.9375rem] transition-colors duration-150 ease-out ${
                          active
                            ? "bg-[rgba(115,87,255,0.08)] text-[#5B43D6]"
                            : "text-ink-secondary hover:bg-sunken hover:text-ink"
                        }`}
                      >
                        <Icon className="size-4 shrink-0" />
                        {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                        {!collapsed && item.label === "Activity" && (
                          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[#F08C46] text-[9px] font-semibold text-white">
                            3
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {!collapsed && (
            <Link
              href="/workspace/overview"
              className="mb-2 block rounded-lg p-3"
              style={{ background: "linear-gradient(135deg, #162238, #101828)" }}
            >
              <p className="text-[11px] font-semibold text-[#C7F36B]">Focus mode</p>
              <p className="mt-1 text-[12px] leading-snug text-white/90">
                Three decisions are ready for your review.
              </p>
              <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-white">
                Open briefing <ArrowRight className="size-3" />
              </span>
            </Link>
          )}
        </nav>

        <div className="border-t border-hairline p-2">
          {!collapsed && userEmail && (
            <div className="flex items-center gap-2 px-2 py-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#101828] text-[11px] font-semibold text-white">
                {userInitials}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[0.8125rem] font-medium text-ink">{userEmail}</span>
              </span>
            </div>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-[0.8125rem] text-ink-secondary transition-colors duration-150 ease-out hover:bg-sunken hover:text-ink"
          >
            {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-hairline bg-raised px-4 md:px-8">
          <p className="type-caption truncate text-ink-tertiary">
            Workspace <span className="px-1">/</span> <span className="text-ink">{title}</span>
          </p>
          <div className="flex items-center gap-1">
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-tertiary" />
              <input
                type="search"
                placeholder="Search workspace"
                aria-label="Search workspace"
                className="h-9 w-[220px] rounded-md border border-strong bg-raised pr-10 pl-8 text-[0.8125rem] text-ink placeholder:text-ink-tertiary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              />
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-strong px-1 text-[10px] text-ink-tertiary">
                ⌘K
              </span>
            </div>
            <button
              aria-label="Notifications"
              className="grid size-9 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
            >
              <Bell className="size-4" />
            </button>
            <button
              aria-label={dark ? "Use light theme" : "Use dark theme"}
              onClick={() => setDark((d) => !d)}
              className="grid size-9 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
            >
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            <button
              aria-label="Sign out"
              onClick={signOut}
              className="grid size-9 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
            >
              <LogOut className="size-4" />
            </button>
            <div className="ml-1 grid size-8 place-items-center rounded-sm bg-sunken text-[0.8125rem] font-medium text-ink-secondary">
              {initials || "?"}
            </div>
          </div>
        </header>

        <div className="md:hidden">
          <nav className="flex gap-1 overflow-x-auto border-b border-hairline bg-raised px-4 py-2">
            {NAV.flatMap((g) => g.items).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 rounded-md px-2 py-1 text-[0.8125rem] ${
                  pathname === item.href ? "bg-accent text-accent-foreground" : "text-ink-secondary"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <main className="page-gutter flex-1 py-6 md:py-8">{children}</main>
      </div>
    </div>
  );
}
