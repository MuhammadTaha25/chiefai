"use client";

import { useState } from "react";

export default function LandingForm({ slug }: { slug: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [company, setCompany] = useState("");
  // Honeypot: hidden from people, bots fill it. The API silently drops those submissions.
  const [hpWebsite, setHpWebsite] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name, email, phone, country, city, company, hp_website: hpWebsite }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setSubmitted(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <p className="mt-6 type-body text-positive">Thanks! We&apos;ll be in touch shortly.</p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 text-left">
      <input
        type="text"
        name="hp_website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={hpWebsite}
        onChange={(e) => setHpWebsite(e.target.value)}
        style={{ position: "absolute", left: "-10000px", width: 1, height: 1, opacity: 0 }}
      />
      <input
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
      />
      <input
        type="email"
        required
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
      />
      <input
        type="tel"
        placeholder="Phone"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        className="w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
      />
      <div className="flex gap-3">
        <input
          placeholder="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="w-1/2 rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
        />
        <input
          placeholder="City"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className="w-1/2 rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
        />
      </div>
      <input
        placeholder="Company (optional)"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        className="w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
      />
      {error && <p className="type-caption text-critical">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-primary px-4 py-2.5 type-body font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
      >
        {loading ? "Sending…" : "Submit"}
      </button>
    </form>
  );
}
