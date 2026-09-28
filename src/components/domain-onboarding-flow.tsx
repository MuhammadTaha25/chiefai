"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Suggested names shown as placeholders for the 5 mailbox slots — a blank
// slot is just skipped, except when every slot is left blank, in which case
// only the first (sales@) gets created, matching the old single-mailbox
// default behavior.
const SUGGESTED_LOCALS = ["sales", "johnson", "michael", "contact", "hello"];

interface CreatedMailbox {
  address: string;
  status: "created" | "already_exists" | "route_failed" | "verifying" | "provisioning_failed";
}

type OnboardingStep = "success" | "confirming" | "waiting" | "failed" | "mailboxes" | "processing" | "done";

/**
 * The popup must describe what is TRUE, not what the Stripe redirect implies.
 * `purchaseStatus` is the real `domain_purchases.status` for this domain:
 *   - "registered"                      -> the domain really is registered
 *   - paid / registering                -> Stripe confirmed the money; registrar still working
 *   - "pending_payment"                 -> NO payment confirmation exists yet
 *   - *_failed                          -> it genuinely did not register
 * Anything else (including "unknown", i.e. no purchase row at all) is treated
 * as unconfirmed. Defaulting to success here is what previously let the UI
 * announce a registered domain that Hostinger had never actually bought.
 */
function stepForStatus(status: string): OnboardingStep {
  if (status === "registered") return "success";
  if (status === "registration_failed" || status === "payment_failed") return "failed";
  // Only "paid"/"registering" carry a confirmed payment, so only those may
  // claim "payment received". "pending_payment" — and an unknown status — mean
  // we have no confirmation at all, and claiming otherwise would be the same
  // class of lie this dialog was fixed for.
  if (status === "paid" || status === "registering") return "waiting";
  return "confirming";
}

export default function DomainOnboardingFlow({
  domain,
  purchaseStatus = "unknown",
  lastError = null,
  initialStep,
  onClose,
}: {
  domain: string;
  purchaseStatus?: string;
  lastError?: string | null;
  initialStep?: OnboardingStep;
  onClose?: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<OnboardingStep>(initialStep ?? stepForStatus(purchaseStatus));
  const [error, setError] = useState<string | null>(null);
  const [mailboxes, setMailboxes] = useState<CreatedMailbox[]>([]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const retriedRef = useRef(0);

  async function handleCreateMailboxes() {
    const typed = inputRefs.current.map((el) => el?.value.trim() ?? "").filter(Boolean);
    const locals = typed.length > 0 ? typed : [SUGGESTED_LOCALS[0]];

    setStep("processing");
    setError(null);
    try {
      const res = await fetch("/api/domains/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, locals }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create mailboxes");
      setMailboxes(data.mailboxes);
      setStep("done");
    } catch (err) {
      const message = (err as Error).message;
      // The domain can still be mid-registration when the client reaches this
      // step (Stripe redirects here immediately, the webhook that registers
      // it via Hostinger runs separately and can take longer) — retry once
      // more automatically instead of making them notice and click Next again.
      if (message.includes("Still finishing registration") && retriedRef.current < 1) {
        retriedRef.current += 1;
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return handleCreateMailboxes();
      }
      setError(message);
      setStep("mailboxes");
    }
  }

  function close() {
    if (onClose) {
      onClose();
    } else {
      router.replace("/domains");
      router.refresh();
    }
  }

  // Escape closes like any other dialog, but never mid-submit — the create
  // request is already in flight and closing then would just orphan it
  // (mailboxes may still get created server-side with no confirmation ever
  // shown, and reopening later would start from "success" again since the
  // domain now genuinely has no mailboxes recorded from this session's view).
  useEffect(() => {
    if (step === "processing") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        // Click-outside closes too, same guard as Escape — but only when the
        // mousedown actually started on the backdrop itself, not a drag that
        // began inside the dialog and was released outside it.
        if (step !== "processing" && e.target === e.currentTarget) close();
      }}
    >
      <div
        className="relative w-full max-w-md rounded-xl border border-black/[.08] bg-background p-6 shadow-xl dark:border-white/[.145]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {step !== "processing" && (
          <button
            onClick={close}
            aria-label="Close"
            className="absolute right-3 top-3 rounded-md p-1 text-zinc-400 hover:bg-black/[.05] hover:text-zinc-600 dark:hover:bg-white/[.08] dark:hover:text-zinc-300"
          >
            ✕
          </button>
        )}
        {step === "success" && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl text-green-600 dark:bg-green-950">
              ✓
            </div>
            <h2 className="text-lg font-semibold">Domain registered</h2>
            <p className="text-sm text-zinc-500">
              {domain} is confirmed registered at the registrar. Set up its inboxes next.
            </p>
            <button
              onClick={() => setStep("mailboxes")}
              className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              Next
            </button>
          </div>
        )}

        {step === "confirming" && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 text-2xl text-zinc-600 dark:bg-zinc-800">
              ⏳
            </div>
            <h2 className="text-lg font-semibold">Confirming payment for {domain}</h2>
            <p className="text-sm text-zinc-500">
              We don&apos;t have confirmation of your payment yet. Nothing is treated as bought or
              registered until the payment provider confirms it — check again in a moment.
            </p>
            <button
              onClick={() => router.refresh()}
              className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              Check again
            </button>
            <button onClick={close} className="w-full text-center text-sm text-zinc-500 hover:underline">
              Close
            </button>
          </div>
        )}

        {step === "waiting" && (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl text-amber-600 dark:bg-amber-950">
              ⏳
            </div>
            <h2 className="text-lg font-semibold">Payment received — registering {domain}</h2>
            <p className="text-sm text-zinc-500">
              Your payment went through, but the domain is <strong>not registered yet</strong>.
              Registration at the registrar is still running — usually a few minutes, occasionally
              up to a few hours. This will only report success once the registrar actually confirms it.
            </p>
            <button
              onClick={() => router.refresh()}
              className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              Check again
            </button>
            <button onClick={close} className="w-full text-center text-sm text-zinc-500 hover:underline">
              Close
            </button>
          </div>
        )}

        {step === "failed" && (
          <div className="space-y-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600 dark:bg-red-950">
              !
            </div>
            <h2 className="text-center text-lg font-semibold">{domain} is not registered</h2>
            <p className="text-center text-sm text-zinc-500">
              The purchase did not complete at the registrar, so no mailboxes can be created on it yet.
            </p>
            {lastError && (
              <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
                {lastError}
              </p>
            )}
            <button
              onClick={close}
              className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              Close
            </button>
          </div>
        )}

        {step === "mailboxes" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Set up your inboxes</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Name up to 5 mailboxes on {domain}. Leave any blank to skip it.
              </p>
            </div>

            {error && (
              <p className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{error}</p>
            )}

            <div className="space-y-2">
              {SUGGESTED_LOCALS.map((suggestion, i) => (
                <div
                  key={suggestion}
                  className="flex items-center rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145]"
                >
                  <input
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    placeholder={suggestion}
                    className="min-w-0 flex-1 bg-transparent outline-none"
                  />
                  <span className="shrink-0 text-zinc-500">@{domain}</span>
                </div>
              ))}
            </div>

            <button
              onClick={handleCreateMailboxes}
              className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              Next
            </button>
            {onClose && (
              <button
                onClick={close}
                className="w-full text-center text-sm text-zinc-500 hover:underline"
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {step === "processing" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-zinc-300 border-t-foreground" />
            <p className="text-sm text-zinc-500">Setting up your mailboxes…</p>
          </div>
        )}

        {step === "done" && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              {mailboxes.every((m) => m.status === "created" || m.status === "already_exists" || m.status === "route_failed")
                ? "Your mailboxes are ready"
                : "Mailbox setup needs attention"}
            </h2>
            <div className="space-y-2">
              {mailboxes.map((m) => (
                <div
                  key={m.address}
                  className="flex items-center justify-between rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145]"
                >
                  <span>{m.address}</span>
                  <span className="text-xs text-zinc-500">
                    {m.status === "created" && "Ready"}
                    {m.status === "already_exists" && "Already existed"}
                    {m.status === "route_failed" && "Ready (replies not yet captured)"}
                    {m.status === "verifying" && "Waiting for DNS verification — can't send yet"}
                    {m.status === "provisioning_failed" && "Setup failed — can't send. Retry from Domains"}
                  </span>
                </div>
              ))}
            </div>
            <button
              onClick={close}
              className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
