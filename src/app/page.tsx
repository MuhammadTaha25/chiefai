import Link from "next/link";

const FEATURES = [
  {
    title: "AI lead generation",
    body: "Your ICP feeds an AI pipeline that finds, researches, and emails qualified leads automatically.",
  },
  {
    title: "AI social & ads",
    body: "Instagram and Facebook content, plus Google/Meta ad optimization, run themselves — you approve the budget.",
  },
  {
    title: "Live finance & projects",
    body: "Revenue, spend, and project status roll up to one dashboard, with a Chief of Staff you can just ask.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between px-6 py-5 sm:px-12">
        <span className="text-lg font-semibold tracking-tight">Infomist</span>
        <nav className="flex items-center gap-4 text-sm font-medium">
          <Link href="/login" className="text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-foreground px-4 py-2 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            Get started
          </Link>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center sm:px-12">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Your whole growth team, run by AI.
        </h1>
        <p className="mt-6 max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
          Infomist provisions your domain and mailboxes, runs lead generation and outreach,
          posts and optimizes your social + ads, and tracks the finance — all visible on one
          live dashboard.
        </p>
        <Link
          href="/signup"
          className="mt-8 rounded-full bg-foreground px-6 py-3 text-base font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Start your onboarding
        </Link>

        <div className="mt-20 grid max-w-4xl gap-8 text-left sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-black/[.08] p-6 dark:border-white/[.145]">
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{f.body}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
