"use client";

import { useRouter } from "next/navigation";
import { DynamicForm } from "@/components/form/dynamic-form";
import { LEAD_GEN_SCHEMA } from "@/lib/form-schema/lead-gen-schema";
import { buildLeadRecommendation } from "@/lib/form-schema/recommendation";
import { FormValues } from "@/lib/form-schema/types";

export default function LeadGenPage() {
  const router = useRouter();

  async function handleSubmit(values: FormValues) {
    const res = await fetch("/api/leads/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to submit");
    router.push("/leads");
  }

  return (
    <div className="py-6">
      <DynamicForm
        sections={LEAD_GEN_SCHEMA}
        title="Tell us who to sell to — no jargon, just plain questions."
        buildRecommendation={buildLeadRecommendation}
        onSubmit={handleSubmit}
        submitLabel="Find leads and start outreach"
      />
    </div>
  );
}
