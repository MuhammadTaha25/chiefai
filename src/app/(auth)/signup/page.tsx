"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({ email, password });

    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }

    if (!data.session) {
      setNeedsConfirmation(true);
      return;
    }

    router.push("/onboarding");
    router.refresh();
  }

  if (needsConfirmation) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 text-center dark:bg-black">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
          <p className="mt-2 max-w-sm text-zinc-600 dark:text-zinc-400">
            We sent a confirmation link to {email}. Click it, then come back and log in.
          </p>
          <Link href="/login" className="mt-6 inline-block font-medium underline">
            Go to login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>

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
            minLength={6}
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
          {loading ? "Creating account…" : "Sign up"}
        </button>

        <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
          Already have an account? <Link href="/login" className="font-medium underline">Log in</Link>
        </p>
      </form>
    </div>
  );
}
