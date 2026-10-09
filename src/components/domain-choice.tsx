"use client";

import { useState, type ReactNode } from "react";

/**
 * P3 FIX (Existing-Domain Feature Audit, 2026-10-09): the purchase panel and
 * the existing-domain form used to render stacked on the page simultaneously
 * instead of the spec's "Choose Your Domain" branching screen. This is a
 * presentational wrapper only — it changes nothing about either path's
 * logic, just which one is visible at a time.
 */
export function DomainChoice({ buyPanel, existingPanel }: { buyPanel: ReactNode; existingPanel: ReactNode }) {
  const [choice, setChoice] = useState<"buy" | "existing" | null>(null);

  if (choice === "buy") return <>{buyPanel}</>;
  if (choice === "existing") return <>{existingPanel}</>;

  return (
    <div className="panel panel-body">
      <h2 className="text-lg font-semibold">Choose your domain</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <button
          onClick={() => setChoice("buy")}
          className="rounded-lg border border-black/[.08] p-5 text-left transition-colors hover:border-black/20 dark:border-white/[.145] dark:hover:border-white/30"
        >
          <p className="font-semibold">Buy a new domain</p>
          <p className="mt-1 text-sm text-zinc-500">Find and purchase a new domain for your outreach.</p>
        </button>
        <button
          onClick={() => setChoice("existing")}
          className="rounded-lg border border-black/[.08] p-5 text-left transition-colors hover:border-black/20 dark:border-white/[.145] dark:hover:border-white/30"
        >
          <p className="font-semibold">Use an existing domain</p>
          <p className="mt-1 text-sm text-zinc-500">Already own a domain? Connect it to your account.</p>
        </button>
      </div>
    </div>
  );
}

export default DomainChoice;
