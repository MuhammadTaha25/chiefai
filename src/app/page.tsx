import Link from "next/link";
import { Compass, Users, Megaphone, Wallet } from "lucide-react";

const FEATURES = [
  {
    title: "Leads & pipeline",
    body: "AI finds, researches, and follows up with qualified leads so the pipeline keeps moving without you chasing it.",
    icon: Users,
  },
  {
    title: "Campaigns & content",
    body: "Social content and ad spend run on autopilot — you approve the budget and the direction.",
    icon: Megaphone,
  },
  {
    title: "Finance & projects",
    body: "Revenue, spend, and project health roll up into one view, with a chief of staff you can just ask.",
    icon: Wallet,
  },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col" style={{ background: "#F7F8FC" }}>
      <header className="flex items-center justify-between px-6 py-5 sm:px-12">
        <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight" style={{ color: "#101828" }}>
          <span className="grid size-7 place-items-center rounded-full text-white" style={{ background: "#7357FF" }}>
            <Compass className="size-4" />
          </span>
          Northstar
        </span>
        <nav className="flex items-center gap-4 text-sm font-medium">
          <Link href="/login" className="text-zinc-600 hover:text-zinc-950">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-full px-4 py-2 text-white transition-colors hover:opacity-90"
            style={{ background: "#101828" }}
          >
            Get started
          </Link>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center sm:px-12">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "#98A2B3" }}>
          Executive operating workspace
        </p>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl" style={{ color: "#101828" }}>
          Run your whole agency from one private workspace.
        </h1>
        <p className="mt-6 max-w-xl text-lg" style={{ color: "#667085" }}>
          Northstar provisions your domain and mailboxes, runs lead generation and outreach,
          posts and optimizes your social and ads, and tracks the finances — all visible in one
          calm, executive-grade workspace.
        </p>
        <Link
          href="/signup"
          className="mt-8 rounded-full px-6 py-3 text-base font-medium text-white transition-colors hover:opacity-90"
          style={{ background: "#7357FF" }}
        >
          Start your onboarding
        </Link>

        <div className="mt-20 grid max-w-4xl gap-6 text-left sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border p-6" style={{ borderColor: "#E4E7EC", background: "#fff" }}>
              <span className="mb-3 grid size-9 place-items-center rounded-full" style={{ background: "#F1F3F7" }}>
                <f.icon className="size-4" style={{ color: "#7357FF" }} />
              </span>
              <h3 className="font-semibold" style={{ color: "#101828" }}>{f.title}</h3>
              <p className="mt-2 text-sm" style={{ color: "#667085" }}>{f.body}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
