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
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }],
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

  useEffect(() => {
    const stored = localStorage.getItem("infomist-theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate persisted theme after mount (avoids SSR mismatch)
    setDark(stored === "dark");
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

  const title = TITLES[pathname] ?? "Dashboard";
  const initials = companyName
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="flex min-h-screen bg-canvas">
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-hairline bg-raised transition-[width] duration-200 ease-out md:flex ${
          collapsed ? "w-[56px]" : "w-[240px]"
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-hairline px-3">
          <div className="grid size-6 shrink-0 place-items-center rounded-sm bg-primary text-[11px] font-semibold text-primary-foreground">
            I
          </div>
          {!collapsed && <span className="type-subhead truncate text-ink">Infomist</span>}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-4">
          {NAV.map((group) => (
            <div key={group.section} className="mb-4">
              {!collapsed && <p className="type-micro px-2 pb-2 text-ink-tertiary">{group.section}</p>}
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        title={item.label}
                        className={`flex h-9 items-center gap-2 rounded-md px-2 text-[0.9375rem] transition-colors duration-150 ease-out ${
                          active
                            ? "bg-accent text-accent-foreground"
                            : "text-ink-secondary hover:bg-sunken hover:text-ink"
                        }`}
                      >
                        <Icon className="size-4 shrink-0" />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-hairline p-2">
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
          <h2 className="type-subhead truncate text-ink">{title}</h2>
          <div className="flex items-center gap-1">
            <div className="relative hidden sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-tertiary" />
              <input
                type="search"
                placeholder="Search"
                aria-label="Search"
                className="h-9 w-[200px] rounded-md border border-strong bg-raised pr-3 pl-8 text-[0.8125rem] text-ink placeholder:text-ink-tertiary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              />
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
