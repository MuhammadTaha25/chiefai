"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { unknownPlaceholders } from "@/lib/custom-template";
import { cleanOutreachEmail, lintOutreachEmail } from "@/lib/email-quality";

type TemplateMode = "ai" | "custom";

export default function OnboardingPage() {
  const router = useRouter();

  // Step 1 fields
  const [companyName, setCompanyName] = useState("");
  const [industry, setIndustry] = useState("");
  const [location, setLocation] = useState("");

  // Step 2 fields
  const [templateMode, setTemplateMode] = useState<TemplateMode>("ai");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");

  const [step, setStep] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validateTemplate(): string | null {
    if (templateMode !== "custom") return null;
    if (!templateSubject.trim() || !templateBody.trim()) return "Subject aur body dono likhein.";
    if (templateSubject.length > 80) return "Subject 80 characters se zyada nahi ho sakta.";
    if (templateBody.length > 2000) return "Body 2000 characters se zyada nahi ho sakta.";
    const unknown = [...unknownPlaceholders(templateSubject), ...unknownPlaceholders(templateBody)];
    if (unknown.length) {
      return `Unknown placeholder: ${[...new Set(unknown)].map((u) => `{${u}}`).join(", ")}. Sirf yeh use karein: {first_name}, {company}, {job_title}, {sender_company}, {website}.`;
    }
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (step === 1) {
      setStep(2);
      return;
    }

    const templateError = validateTemplate();
    if (templateError) {
      setError(templateError);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        companyName,
        icpIndustry: industry,
        icpLocation: location,
      };
      if (templateMode === "custom") {
        payload.templateSubject = templateSubject.trim();
        payload.templateBody = templateBody.trim();
      }

      const res = await fetch("/api/onboarding/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-2">
          <div className={`h-2 w-2 rounded-full ${step === 1 ? "bg-primary" : "bg-primary/40"}`} />
          <div className={`h-2 w-2 rounded-full ${step === 2 ? "bg-primary" : "bg-primary/40"}`} />
          <span className="type-caption text-ink-tertiary ml-1">Step {step} of 2</span>
        </div>

        {step === 1 && (
          <div className="panel panel-body space-y-4">
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

            <button
              type="submit"
              disabled={!companyName}
              className="w-full rounded-md bg-primary px-4 py-2.5 type-body font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
            >
              Continue →
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="panel panel-body space-y-4">
            <div>
              <h1 className="type-heading text-ink">Email outreach template</h1>
              <p className="mt-1 type-caption text-ink-tertiary">
                ChiefAI sends cold emails to your leads automatically. Choose how the emails should be written.
              </p>
            </div>

            {/* Choice cards */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => { setTemplateMode("ai"); setError(null); }}
                className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
                  templateMode === "ai"
                    ? "border-primary bg-primary/5"
                    : "border-strong bg-raised hover:bg-raised/80"
                }`}
              >
                <p className="type-body font-semibold text-ink">
                  ✨ ChiefAI writes the emails
                  {templateMode === "ai" && <span className="ml-2 text-xs font-normal text-primary">Selected</span>}
                </p>
                <p className="type-caption text-ink-tertiary mt-0.5">
                  AI drafts a personalised AIDA email for each lead using your business context. Recommended.
                </p>
              </button>

              <button
                type="button"
                onClick={() => { setTemplateMode("custom"); setError(null); }}
                className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
                  templateMode === "custom"
                    ? "border-primary bg-primary/5"
                    : "border-strong bg-raised hover:bg-raised/80"
                }`}
              >
                <p className="type-body font-semibold text-ink">
                  ✏️ I&apos;ll write my own template
                  {templateMode === "custom" && <span className="ml-2 text-xs font-normal text-primary">Selected</span>}
                </p>
                <p className="type-caption text-ink-tertiary mt-0.5">
                  Write a fixed template once. It will be sent to every lead (with placeholders filled in).
                </p>
              </button>
            </div>

            {/* Custom template fields */}
            {templateMode === "custom" && (
              <div className="space-y-3 rounded-lg border border-strong bg-raised/50 p-3">
                <p className="type-caption text-ink-tertiary">
                  Use these placeholders: <code className="font-mono text-ink">{"{first_name}"}</code>,{" "}
                  <code className="font-mono text-ink">{"{company}"}</code>,{" "}
                  <code className="font-mono text-ink">{"{job_title}"}</code>,{" "}
                  <code className="font-mono text-ink">{"{sender_company}"}</code>,{" "}
                  <code className="font-mono text-ink">{"{website}"}</code>
                </p>
                <div>
                  <label className="type-caption font-semibold text-ink-secondary">Subject line</label>
                  <input
                    value={templateSubject}
                    onChange={(e) => { setTemplateSubject(e.target.value); setError(null); }}
                    placeholder="e.g. Quick question for {first_name} at {company}"
                    className="mt-1.5 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
                  />
                </div>
                <div>
                  <label className="type-caption font-semibold text-ink-secondary">Email body</label>
                  <textarea
                    rows={7}
                    value={templateBody}
                    onChange={(e) => { setTemplateBody(e.target.value); setError(null); }}
                    placeholder={`Hi {first_name},\n\nQuick note about {company}...\n\nBest,\n{sender_company}`}
                    className="mt-1.5 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring resize-none font-mono text-xs"
                  />
                  <p className="mt-1 type-caption text-ink-tertiary text-right">{templateBody.length}/2000</p>
                </div>
              </div>
            )}

            {error && <p className="type-caption text-critical">{error}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setStep(1); setError(null); }}
                className="flex-1 rounded-md border border-strong px-4 py-2.5 type-body font-semibold text-ink hover:bg-raised"
              >
                ← Back
              </button>
              <button
                type="submit"
                disabled={loading || (templateMode === "custom" && (!templateSubject.trim() || !templateBody.trim()))}
                className="flex-1 rounded-md bg-primary px-4 py-2.5 type-body font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                {loading ? "Setting up…" : "Get started"}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
