"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionConfig, FormValues } from "@/lib/form-schema/types";
import { FieldRenderer } from "./field-renderer";
import { Recommendation } from "@/lib/form-schema/recommendation";

interface DraftState {
  step: number;
  reviewing: boolean;
  values: FormValues;
}

// Nothing here is submitted until the final "Review plan" -> submit click, so
// losing it to a tab switch or an accidental nav click is pure lost work for
// the user, not a state-consistency issue — sessionStorage (per-tab, cleared
// on close) is the right home for it: it survives switching to another page
// in the app and back, and a refresh, without ever being something the
// server or another viewer needs to know about.
function draftKey(formId: string) {
  return `infomist:dynamic-form-draft:${formId}`;
}

function loadDraft(formId: string): DraftState | null {
  try {
    const raw = sessionStorage.getItem(draftKey(formId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as DraftState;
  } catch {
    return null;
  }
}

export function DynamicForm({
  sections,
  title,
  buildRecommendation,
  onSubmit,
  submitLabel = "Find leads",
  formId = "default",
  reviewTitle = "Here's what we'll look for",
  reviewNote = "Review the plan below. Submitting only finds and saves leads — no emails are sent. You will draft, review and send each email yourself from the Leads page.",
  initialValues,
  initialReviewing = false,
}: {
  sections: SectionConfig[];
  title: string;
  buildRecommendation: (v: FormValues) => Recommendation;
  onSubmit: (v: FormValues) => Promise<void>;
  submitLabel?: string;
  formId?: string;
  /** Heading + explanation shown on the final review step. Defaults match the lead-gen form. */
  reviewTitle?: string;
  reviewNote?: string;
  /** Pre-fills the form (e.g. reopening a previously submitted brief for editing). Ignored once a sessionStorage draft exists for this formId. */
  initialValues?: FormValues;
  /** Skip straight to the review step with initialValues already filled in. */
  initialReviewing?: boolean;
}) {
  // Lazy initializers run once on mount, before the first paint — this is
  // what makes returning to the page show restored progress instead of a
  // flash of step 1 followed by a jump to the real step.
  const [step, setStep] = useState(() => loadDraft(formId)?.step ?? 0);
  const [reviewing, setReviewing] = useState(() => loadDraft(formId)?.reviewing ?? initialReviewing);
  const [values, setValues] = useState<FormValues>(() => loadDraft(formId)?.values ?? initialValues ?? {});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey(formId), JSON.stringify({ step, reviewing, values }));
    } catch {
      // Private browsing / storage disabled — form still works, it just
      // won't survive a tab switch. Not worth surfacing to the user.
    }
  }, [formId, step, reviewing, values]);

  function clearDraft() {
    try {
      sessionStorage.removeItem(draftKey(formId));
    } catch {
      // ignore
    }
  }

  const visibleSections = useMemo(
    () => sections.filter((s) => !s.showIf || s.showIf(values)),
    [sections, values]
  );

  // Every field in an `optional` section is non-required AI context, not something that changes whether
  // the search even runs — forcing a client through each one as its own mandatory wizard step made the
  // form feel long before they ever reached something that actually mattered. Core sections stay a normal
  // step-by-step flow; every optional section is grouped behind a single "add more detail?" opt-in after
  // them, so the default path is short and fine-tuning is there for whoever wants it.
  type WizardItem = { kind: "section"; section: SectionConfig } | { kind: "interstitial" };
  const coreSections = useMemo(() => visibleSections.filter((s) => !s.optional), [visibleSections]);
  const advancedSections = useMemo(() => visibleSections.filter((s) => s.optional), [visibleSections]);
  const items = useMemo<WizardItem[]>(
    () => [
      ...coreSections.map((section) => ({ kind: "section" as const, section })),
      ...(advancedSections.length ? [{ kind: "interstitial" as const }] : []),
      ...advancedSections.map((section) => ({ kind: "section" as const, section })),
    ],
    [coreSections, advancedSections]
  );
  const current = items[step];
  // The step counter and progress dots only ever count what the client is actually committed to right
  // now: while in the core flow, "N of coreSections.length" (never the inflated total including optional
  // sections they may skip entirely) — that total is exactly what made the form look long. Once they've
  // opted into fine-tuning, the counter switches to its own "optional N of advancedSections.length".
  const inCoreRange = step < coreSections.length;
  const advancedIndex = step - coreSections.length - 1; // 0-based position within advancedSections, once past the interstitial
  const section = current?.kind === "section" ? current.section : undefined;

  function set(id: string, value: unknown) {
    setValues((v) => ({ ...v, [id]: value }));
  }

  const visibleFields = useMemo(
    () => (section ? section.fields.filter((f) => !f.showIf || f.showIf(values)) : []),
    [section, values]
  );

  const requiredMissing = visibleFields.some((f) => {
    if (!f.required) return false;
    const v = values[f.id];
    return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });

  const recommendation = useMemo(() => buildRecommendation(values), [values, buildRecommendation]);

  async function handleFinalSubmit() {
    setLoading(true);
    setError(null);
    try {
      await onSubmit(values);
      clearDraft();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (reviewing) {
    return (
      <div className="mx-auto max-w-xl">
        <h2 className="text-xl font-semibold tracking-tight">{reviewTitle}</h2>
        <p className="mt-1 text-sm text-zinc-500">{reviewNote}</p>

        <div className="mt-6 space-y-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          {recommendation.rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-4 text-sm">
              <span className="text-zinc-500">{r.label}</span>
              <span className="text-right font-medium">{r.value}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
          <p className="text-sm font-medium">Why we chose this</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-zinc-500">
            {recommendation.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>

        <label className="mt-5 flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={agreedToTerms}
            onChange={(e) => setAgreedToTerms(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-700"
          />
          <span>
            I agree to the{" "}
            <a href="/terms" target="_blank" rel="noopener noreferrer" className="font-medium underline">
              Terms and Conditions
            </a>{" "}
            and{" "}
            <a href="/privacy" target="_blank" rel="noopener noreferrer" className="font-medium underline">
              Privacy Policy
            </a>
            .
          </span>
        </label>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-6 flex justify-between">
          <button
            type="button"
            onClick={() => setReviewing(false)}
            className="rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium dark:border-zinc-800"
          >
            Edit answers
          </button>
          <button
            type="button"
            onClick={handleFinalSubmit}
            disabled={loading || !agreedToTerms}
            className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {loading ? "Submitting…" : submitLabel}
          </button>
        </div>
      </div>
    );
  }

  if (!current) return null;

  const isLast = step === items.length - 1;
  const inAdvanced = section?.optional === true;

  if (current.kind === "interstitial") {
    return (
      <div className="mx-auto max-w-xl">
        <div className="mb-6 flex gap-1.5">
          {coreSections.map((s) => (
            <div key={s.id} className="h-1.5 flex-1 rounded-full bg-foreground" />
          ))}
        </div>

        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Want to fine-tune your search?</h1>
        <p className="mt-1.5 text-sm text-zinc-500">
          Everything from here is optional. It helps the AI narrow things down further, but your search works fine without it.
        </p>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-8 flex justify-between">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            className="rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium dark:border-zinc-800"
          >
            Back
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setReviewing(true)}
              className="rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium dark:border-zinc-800"
            >
              Skip, review now
            </button>
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:bg-[#383838] dark:hover:bg-[#ccc]"
            >
              Add more detail
            </button>
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-zinc-400">{title}</p>
      </div>
    );
  }

  if (!section) return null;

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex gap-1.5">
        {(inCoreRange ? coreSections : advancedSections).map((s, i) => (
          <div
            key={s.id}
            className={`h-1.5 flex-1 rounded-full ${
              i <= (inCoreRange ? step : advancedIndex) ? "bg-foreground" : "bg-zinc-200 dark:bg-zinc-800"
            }`}
          />
        ))}
      </div>

      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {inCoreRange
          ? `Step ${step + 1} of ${coreSections.length}`
          : `Optional step ${advancedIndex + 1} of ${advancedSections.length}`}
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{section.title}</h1>
      {section.intro && <p className="mt-1.5 text-sm text-zinc-500">{section.intro}</p>}

      <div className="mt-6 space-y-6">
        {visibleFields.map((field) => (
          <FieldRenderer key={field.id} field={field} values={values} onChange={set} />
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium disabled:opacity-30 dark:border-zinc-800"
        >
          Back
        </button>
        <div className="flex items-center gap-4">
          {inAdvanced && (
            <button type="button" onClick={() => setReviewing(true)} className="text-sm font-medium text-zinc-500 underline">
              Skip remaining, review now
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (isLast) setReviewing(true);
              else setStep((s) => s + 1);
            }}
            disabled={requiredMissing}
            className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {isLast ? "Review plan" : "Next"}
          </button>
        </div>
      </div>
      <p className="mt-6 text-center text-xs text-zinc-400">{title}</p>
    </div>
  );
}
