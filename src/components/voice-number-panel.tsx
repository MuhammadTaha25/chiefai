"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface VoiceNumberPanelProps {
  initialNumber: string | null;
  initialStatus: string | null;
}

type UiState =
  | { kind: "none" }
  | { kind: "provisioning" }
  | { kind: "active"; number: string; agentLinked: boolean | null }
  | { kind: "failed"; message: string }
  | { kind: "unavailable" };

const UNAVAILABLE_TEXT = "Voice number provisioning is currently unavailable. Please configure the voice provider first.";

/**
 * Voice number card. The server decides everything (tenant, purchase, state):
 * this component only calls /api/voice/provision-number, never a provider.
 */
export default function VoiceNumberPanel({ initialNumber }: VoiceNumberPanelProps) {
  const [ui, setUi] = useState<UiState>(initialNumber ? { kind: "active", number: initialNumber, agentLinked: null } : { kind: "none" });
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyStatus = useCallback((s: { state?: string; status?: string; phoneNumber?: string; phone_number?: string; agentLinked?: boolean; available?: boolean; error?: string }) => {
    const st = s.state ?? s.status;
    if (st === "active") setUi({ kind: "active", number: (s.phoneNumber ?? s.phone_number) as string, agentLinked: s.agentLinked ?? null });
    else if (st === "provisioning") setUi({ kind: "provisioning" });
    else if (st === "failed") setUi({ kind: "failed", message: s.error ?? "Provisioning failed." });
    else if (st === "unavailable" || s.available === false) setUi((cur) => (cur.kind === "none" ? { kind: "unavailable" } : cur));
    else setUi({ kind: "none" });
  }, []);

  // Poll while a provisioning is in flight (another tab/click may own it).
  useEffect(() => {
    if (ui.kind !== "provisioning") return;
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/voice/provision-number");
        if (res.ok) applyStatus(await res.json());
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [ui, applyStatus]);

  // Initial truth from the server (failed / provisioning / provider availability).
  useEffect(() => {
    if (initialNumber) return;
    fetch("/api/voice/provision-number")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && applyStatus(s))
      .catch(() => {});
  }, [initialNumber, applyStatus]);

  async function provision() {
    if (busy.current) return; // no duplicate clicks; the server also guards this
    busy.current = true;
    setUi({ kind: "provisioning" });
    try {
      const res = await fetch("/api/voice/provision-number", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) setUi({ kind: "unavailable" });
      else if (res.ok) applyStatus(data);
      else setUi({ kind: "failed", message: data.error ?? "Provisioning failed." });
    } catch {
      setUi({ kind: "failed", message: "Could not reach the server. Please try again." });
    } finally {
      busy.current = false;
    }
  }

  if (ui.kind === "active") {
    return (
      <div className="flex items-center justify-between rounded-md border border-black/[.08] px-4 py-3 text-sm dark:border-white/[.145]">
        <div>
          <p className="font-medium">{ui.number}</p>
          <p className="text-xs text-zinc-500">
            Call this number any time for a spoken summary of leads, emails, social posts, and ad spend.
            {ui.agentLinked === false && " Voice agent link is not confirmed yet."}
          </p>
        </div>
        <span className="rounded-full bg-green-100 px-2 py-1 text-xs text-green-800 dark:bg-green-950 dark:text-green-300">active</span>
      </div>
    );
  }

  if (ui.kind === "unavailable") {
    return (
      <p className="rounded-md border border-black/[.08] px-4 py-3 text-sm text-zinc-600 dark:border-white/[.145] dark:text-zinc-400">{UNAVAILABLE_TEXT}</p>
    );
  }

  return (
    <div className="space-y-2">
      {ui.kind === "failed" && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">Provisioning failed. {ui.message}</p>
      )}
      <button
        onClick={provision}
        disabled={ui.kind === "provisioning"}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
      >
        {ui.kind === "provisioning" ? "Provisioning..." : ui.kind === "failed" ? "Retry" : "Get a business phone number"}
      </button>
      <p className="text-xs text-zinc-500">Provisions a dedicated number you can call for a live spoken business summary.</p>
    </div>
  );
}
