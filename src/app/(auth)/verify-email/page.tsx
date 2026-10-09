"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function VerifyEmailInner() {
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const linkToken = params.get("token");

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submitVerification(payload: { code?: string; token?: string }) {
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ...payload }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Verification failed");
        setVerifying(false);
        return;
      }
      setVerified(true);
      setTimeout(() => {
        router.push("/onboarding");
        router.refresh();
      }, 1200);
    } catch {
      setError("Network error — please try again");
      setVerifying(false);
    }
  }

  // Clicking the emailed link lands here with ?token=... — auto-verify immediately.
  useEffect(() => {
    if (linkToken && email) {
      submitVerification({ token: linkToken });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkToken, email]);

  async function handleResend() {
    setResendStatus("sending");
    try {
      const res = await fetch("/api/auth/signup/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setResendStatus(res.ok ? "sent" : "error");
    } catch {
      setResendStatus("error");
    }
  }

  if (!email) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 text-center dark:bg-black">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Missing email</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Start from the <Link href="/signup" className="font-medium underline">signup page</Link> again.
          </p>
        </div>
      </div>
    );
  }

  if (verified) {
    return (
      <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 text-center dark:bg-black">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Email verified</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">Taking you to get started…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          We sent a 6-digit code to <span className="font-medium">{email}</span>. Enter it below, or click the link in the email.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitVerification({ code });
          }}
          className="space-y-4 text-left"
        >
          <div>
            <label className="block text-sm font-medium">Verification code</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              className="mt-1 w-full rounded-md border border-black/[.1] px-3 py-2 text-center text-lg tracking-[0.5em] dark:border-white/[.145] dark:bg-transparent"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={verifying || code.length !== 6}
            className="w-full rounded-full bg-foreground px-5 py-2.5 font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {verifying ? "Verifying…" : "Verify"}
          </button>
        </form>

        <button
          type="button"
          onClick={handleResend}
          disabled={resendStatus === "sending"}
          className="text-sm font-medium underline disabled:opacity-50"
        >
          {resendStatus === "sending" ? "Sending…" : resendStatus === "sent" ? "Code resent" : "Resend code"}
        </button>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailInner />
    </Suspense>
  );
}
