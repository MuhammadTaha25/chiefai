"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }

    // same-site paths only: "//host" and absolute URLs would be an open redirect after login
      const requested = searchParams.get("next") || "";
      router.push(requested.startsWith("/") && !requested.startsWith("//") && !requested.startsWith("/\\") ? requested : "/dashboard");
    router.refresh();
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>

        <div>
          <label className="block text-sm font-medium">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-black/[.1] px-3 py-2 dark:border-white/[.145] dark:bg-transparent"
          />
        </div>

        <div>
          <label className="block text-sm font-medium">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-black/[.1] px-3 py-2 dark:border-white/[.145] dark:bg-transparent"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-foreground px-5 py-2.5 font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {loading ? "Logging in…" : "Log in"}
        </button>

        <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
          No account? <Link href="/signup" className="font-medium underline">Sign up</Link>
        </p>

        {process.env.NODE_ENV === "development" && (
          <a
            href={`/api/dev/auto-login?next=${encodeURIComponent(searchParams.get("next") || "/domains")}`}
            className="block w-full rounded-full border border-dashed border-black/[.2] px-5 py-2.5 text-center text-sm font-medium text-zinc-600 hover:bg-black/[.03] dark:border-white/[.2] dark:text-zinc-400 dark:hover:bg-white/[.05]"
          >
            Continue as test user (dev only)
          </a>
        )}
      </form>
    </div>
  );
}
