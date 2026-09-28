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
}) {
  // Lazy initializers run once on mount, before the first paint — this is
  // what makes returning to the page show restored progress instead of a
  // flash of step 1 followed by a jump to the real step.
  const [step, setStep] = useState(() => loadDraft(formId)?.step ?? 0);
  const [reviewing, setReviewing] = useState(() => loadDraft(formId)?.reviewing ?? false);
  const [values, setValues] = useState<FormValues>(() => loadDraft(formId)?.values ?? {});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const section = visibleSections[step];

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
            disabled={loading}
            className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {loading ? "Submitting…" : submitLabel}
          </button>
        </div>
      </div>
    );
  }

  if (!section) return null;

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex gap-1.5">
        {visibleSections.map((s, i) => (
          <div key={s.id} className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-foreground" : "bg-zinc-200 dark:bg-zinc-800"}`} />
        ))}
      </div>

      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Step {step + 1} of {visibleSections.length}
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{section.title}</h1>
      {section.intro && <p className="mt-1.5 text-sm text-zinc-500">{section.intro}</p>}

      <div className="mt-6 space-y-6">
        {visibleFields.map((field) => (
          <FieldRenderer key={field.id} field={field} values={values} onChange={set} />
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-8 flex justify-between">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="rounded-full border border-zinc-200 px-5 py-2.5 text-sm font-medium disabled:opacity-30 dark:border-zinc-800"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            if (step === visibleSections.length - 1) setReviewing(true);
            else setStep((s) => s + 1);
          }}
          disabled={requiredMissing}
          className="rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {step === visibleSections.length - 1 ? "Review plan" : "Next"}
        </button>
      </div>
      <p className="mt-6 text-center text-xs text-zinc-400">{title}</p>
    </div>
  );
}
