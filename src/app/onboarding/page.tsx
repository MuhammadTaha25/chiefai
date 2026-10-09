"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [industry, setIndustry] = useState("");
  const [location, setLocation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName, icpIndustry: industry, icpLocation: location }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to save");
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <form onSubmit={submit} className="w-full max-w-sm panel panel-body space-y-4">
        <div>
          <h1 className="type-heading text-ink">Welcome to ChiefAI</h1>
          <p className="mt-1 type-caption text-ink-tertiary">
            Just a couple of quick details to get your account started — you can fill in everything
            else (marketing voice, connecting accounts, domain) later from Settings, whenever you&apos;re ready.
          </p>
        </div>

        <div>
          <label className="type-caption font-semibold text-ink-secondary">Business name</label>
          <input
            required
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="e.g. Acme Fitness"
            className="mt-1.5 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
          />
        </div>

        <div>
          <label className="type-caption font-semibold text-ink-secondary">
            What industry are you in? <span className="text-ink-tertiary font-normal">(optional)</span>
          </label>
          <input
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="e.g. fitness coaching"
            className="mt-1.5 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
          />
        </div>

        <div>
          <label className="type-caption font-semibold text-ink-secondary">
            Where are you located? <span className="text-ink-tertiary font-normal">(optional)</span>
          </label>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Austin, TX"
            className="mt-1.5 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
          />
        </div>

        {error && <p className="type-caption text-critical">{error}</p>}

        <button
          type="submit"
          disabled={loading || !companyName}
          className="w-full rounded-md bg-primary px-4 py-2.5 type-body font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
        >
          {loading ? "Setting up…" : "Get started"}
        </button>
      </form>
    </div>
  );
}
