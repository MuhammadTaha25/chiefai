"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type BookingInfo = {
  invitee_name: string | null;
  invitee_email: string;
  meeting_topic: string | null;
  scheduled_at: string;
  meeting_duration: number;
  feedback_submitted_at: string | null;
};

const OUTCOMES = [
  { value: "completed", label: "✅ Meeting happened" },
  { value: "no_show", label: "❌ They didn't show up" },
  { value: "rescheduled", label: "🔄 We rescheduled" },
  { value: "cancelled", label: "🚫 It was cancelled" },
  { value: "other", label: "Other" },
];

const NEXT_STEPS = [
  { value: "send_proposal", label: "Send a proposal" },
  { value: "follow_up", label: "Follow up later" },
  { value: "close", label: "Mark as closed / won" },
  { value: "nurture", label: "Nurture (not ready yet)" },
  { value: "lost", label: "Lost / not interested" },
];

export default function FeedbackPage() {
  const { token } = useParams<{ token: string }>();
  const [booking, setBooking] = useState<BookingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [outcome, setOutcome] = useState("");
  const [wentWell, setWentWell] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/feedback/${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setNotFound(true); }
        else {
          setBooking(d.booking);
          if (d.booking.feedback_submitted_at) setSubmitted(true);
        }
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!outcome) { setError("Please select what happened in the meeting."); return; }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/feedback/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, went_well: wentWell, next_step: nextStep, notes }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? "Something went wrong."); }
      else { setSubmitted(true); }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading…</div>;
  if (notFound) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center p-8">
        <p className="text-2xl font-semibold text-gray-700">Link not found</p>
        <p className="text-gray-400 mt-2">This feedback link is invalid or has expired.</p>
      </div>
    </div>
  );

  const leadName = booking?.invitee_name || booking?.invitee_email || "your lead";
  const topic = booking?.meeting_topic || "Meeting";

  if (submitted) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-10 max-w-md w-full text-center">
        <div className="text-5xl mb-4">🎯</div>
        <h1 className="text-xl font-semibold text-gray-800 mb-2">Thanks for the update!</h1>
        <p className="text-gray-500">We&apos;ll use this to plan the right next step for {leadName}.</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 max-w-lg w-full">
        <h1 className="text-xl font-semibold text-gray-800 mb-1">How did the meeting go?</h1>
        <p className="text-sm text-gray-500 mb-6">
          {topic} with <span className="font-medium text-gray-700">{leadName}</span>
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Outcome */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">What happened?</label>
            <div className="space-y-2">
              {OUTCOMES.map((o) => (
                <label key={o.value} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${outcome === o.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"}`}>
                  <input type="radio" name="outcome" value={o.value} checked={outcome === o.value} onChange={() => setOutcome(o.value)} className="sr-only" />
                  <span className="text-sm text-gray-700">{o.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Only show rest if meeting happened */}
          {outcome === "completed" && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">What went well? <span className="text-gray-400 font-normal">(optional)</span></label>
                <textarea value={wentWell} onChange={(e) => setWentWell(e.target.value)} rows={2} placeholder="They were interested in pricing, asked about timeline…" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">What&apos;s the next step?</label>
                <div className="space-y-2">
                  {NEXT_STEPS.map((s) => (
                    <label key={s.value} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${nextStep === s.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"}`}>
                      <input type="radio" name="next_step" value={s.value} checked={nextStep === s.value} onChange={() => setNextStep(s.value)} className="sr-only" />
                      <span className="text-sm text-gray-700">{s.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Notes always visible */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Any notes? <span className="text-gray-400 font-normal">(optional)</span></label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything else to remember…" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button type="submit" disabled={submitting || !outcome} className="w-full bg-blue-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {submitting ? "Saving…" : "Submit feedback"}
          </button>
        </form>
      </div>
    </div>
  );
}
