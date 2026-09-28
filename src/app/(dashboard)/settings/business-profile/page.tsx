"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GOAL_OPTIONS, CTA_OPTIONS } from "@/lib/content-strategy";

function TagField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function commit() {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  }
  return (
    <div>
      <label className="type-caption font-semibold text-ink-secondary">{label}</label>
      <div className="mt-1.5 flex flex-wrap gap-2 rounded-md border border-strong bg-raised p-2">
        {value.map((v) => (
          <span key={v} className="badge-base badge-neutral normal-case">
            {v}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} className="ml-1">
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
          placeholder="Type and press Enter"
          className="min-w-[140px] flex-1 bg-transparent type-caption outline-none"
        />
      </div>
    </div>
  );
}

function Field({
  label,
  optional,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; optional?: boolean }) {
  return (
    <div>
      <label className="type-caption font-semibold text-ink-secondary">
        {label} {optional && <span className="font-normal text-ink-tertiary">(optional)</span>}
      </label>
      <input
        {...props}
        className="mt-1.5 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
      />
    </div>
  );
}

function TextArea({
  label,
  optional,
  help,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; optional?: boolean; help?: string }) {
  return (
    <div>
      <label className="type-caption font-semibold text-ink-secondary">
        {label} {optional && <span className="font-normal text-ink-tertiary">(optional)</span>}
      </label>
      {help && <p className="mt-0.5 type-caption text-ink-tertiary">{help}</p>}
      <textarea
        rows={3}
        {...props}
        className="mt-1.5 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
      />
    </div>
  );
}

function Select({
  label,
  options,
  optional,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: readonly { value: string; label: string }[]; optional?: boolean }) {
  return (
    <div>
      <label className="type-caption font-semibold text-ink-secondary">
        {label} {optional && <span className="font-normal text-ink-tertiary">(optional)</span>}
      </label>
      <select
        {...props}
        className="mt-1.5 w-full rounded-md border border-strong bg-raised px-3 py-2 type-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-ring"
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface Product {
  name: string;
  description: string;
  benefit: string;
  price: string;
  url: string;
}
const EMPTY_PRODUCT: Product = { name: "", description: "", benefit: "", price: "", url: "" };

const TONES = ["Professional", "Friendly", "Educational", "Premium", "Conversational", "Bold", "Simple", "Casual"];

type Form = {
  company_name: string;
  website: string;
  niche: string;
  business_description: string;
  location: string;
  products: Product[];
  focus_all: boolean;
  focus_products: string[];
  services: string;
  target_audience: string[];
  pain_points: string;
  desired_outcomes: string;
  why_choose_us: string;
  usps: string;
  proof: string;
  tone_of_voice: string[];
  tagline: string;
  must_not_say: string;
  negative_constraints: string;
  visual_style: string;
  brand_colors: string[];
  language: string;
  emoji_style: string;
  caption_styles: string[];
  brand_keywords: string;
  content_pillars: string[];
  primary_goal: string;
  secondary_goal: string;
  primary_cta: string;
  cta_destination: string;
  cta_phrase: string;
  preferred_ctas: string[];
  faqs: string;
  offers: string;
  pricing_info: string;
  must_say: string;
  contact_method: string;
  booking_method: string;
  business_hours: string;
  icp_industry: string;
  icp_min_employees: string;
  icp_max_employees: string;
  icp_location: string;
  landing_slug: string;
};

const BLANK: Form = {
  company_name: "", website: "", niche: "", business_description: "", location: "",
  products: [], focus_all: true, focus_products: [], services: "",
  target_audience: [], pain_points: "", desired_outcomes: "",
  why_choose_us: "", usps: "", proof: "",
  tone_of_voice: [], tagline: "", must_not_say: "", negative_constraints: "", visual_style: "", brand_colors: [],
  language: "English", emoji_style: "", caption_styles: [], brand_keywords: "", content_pillars: [],
  primary_goal: "", secondary_goal: "", primary_cta: "", cta_destination: "", cta_phrase: "", preferred_ctas: [],
  faqs: "", offers: "", pricing_info: "", must_say: "", contact_method: "", booking_method: "", business_hours: "",
  icp_industry: "", icp_min_employees: "", icp_max_employees: "", icp_location: "", landing_slug: "",
};

const s = (v: unknown) => (typeof v === "string" ? v : "");
const a = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

export default function BusinessProfilePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextAfterSave = searchParams.get("next");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteOrigin, setSiteOrigin] = useState("");
  const [f, setF] = useState<Form>(BLANK);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setF((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    fetch("/api/settings/business-profile")
      .then((r) => r.json())
      .then((data) => {
        const p = data.profile ?? {};
        const products: Product[] = Array.isArray(p.products)
          ? p.products.map((x: Record<string, unknown>) => ({
              name: s(x.name), description: s(x.description), benefit: s(x.benefit), price: s(x.price), url: s(x.url),
            }))
          : [];
        setF({
          ...BLANK,
          company_name: s(data.company_name),
          website: s(p.website),
          niche: s(p.niche),
          business_description: s(p.business_description),
          location: s(p.location),
          products,
          focus_all: a(p.focus_products).length === 0,
          focus_products: a(p.focus_products),
          services: products.length ? "" : s(p.services),
          target_audience: a(p.target_audience),
          pain_points: s(p.pain_points),
          desired_outcomes: s(p.desired_outcomes),
          why_choose_us: s(p.why_choose_us),
          usps: s(p.usps),
          proof: s(p.proof),
          tone_of_voice: a(p.tone_of_voice),
          tagline: s(p.tagline),
          must_not_say: s(p.must_not_say),
          negative_constraints: s(p.negative_constraints),
          visual_style: s(p.visual_style),
          brand_colors: a(p.brand_colors),
          language: s(p.language) || "English",
          emoji_style: s(p.emoji_style),
          caption_styles: a(p.caption_styles),
          brand_keywords: s(p.brand_keywords),
          content_pillars: a(p.content_pillars),
          primary_goal: s(p.primary_goal),
          secondary_goal: s(p.secondary_goal),
          primary_cta: s(p.primary_cta),
          cta_destination: s(p.cta_destination),
          cta_phrase: s(p.cta_phrase),
          preferred_ctas: a(p.preferred_ctas),
          faqs: s(p.faqs),
          offers: s(p.offers),
          pricing_info: s(p.pricing_info),
          must_say: s(p.must_say),
          contact_method: s(p.contact_method),
          booking_method: s(p.booking_method),
          business_hours: s(p.business_hours),
          icp_industry: s(data.icp_industry),
          icp_min_employees: data.icp_min_employees?.toString() ?? "",
          icp_max_employees: data.icp_max_employees?.toString() ?? "",
          icp_location: s(data.icp_location),
          landing_slug: s(data.landing_slug),
        });
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only origin, known after mount
    setSiteOrigin(window.location.origin);
  }, []);

  function setProduct(i: number, patch: Partial<Product>) {
    setF((prev) => {
      const products = prev.products.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
      // Renaming a product must not leave a stale focus entry behind.
      const names = new Set(products.map((p) => p.name));
      return { ...prev, products, focus_products: prev.focus_products.filter((n) => names.has(n)) };
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/business-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, focus_products: f.focus_all ? [] : f.focus_products }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setSaved(true);
      if (nextAfterSave && nextAfterSave.startsWith("/") && !nextAfterSave.startsWith("//") && !nextAfterSave.startsWith("/\\")) {
        router.push(nextAfterSave);
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="type-caption text-ink-tertiary">Loading…</p>;

  const cta = CTA_OPTIONS.find((c) => c.value === f.primary_cta);
  const namedProducts = f.products.filter((p) => p.name.trim());
  const slug = f.landing_slug.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="type-display text-ink">Business Profile</h1>
        <p className="mt-1 type-body text-ink-secondary">
          Tell us about your business. You don&apos;t need to plan any content — your AI decides what to
          post, and uses everything here to write posts and to answer comments and DMs. It only ever
          states facts you give it here: it never invents prices, services, offers or proof.
        </p>
      </div>

      <form onSubmit={save} className="space-y-6">
        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">A · Your business</h2>
          <Field label="Business / brand name" value={f.company_name} onChange={(e) => set("company_name", e.target.value)} required />
          <Field label="Website" optional value={f.website} onChange={(e) => set("website", e.target.value)} />
          <Field label="Industry" value={f.niche} onChange={(e) => set("niche", e.target.value)} required />
          <TextArea
            label="Business description"
            help="Describe your business in 2–5 sentences. Tell us what you do, what you offer, and who you serve."
            value={f.business_description}
            onChange={(e) => set("business_description", e.target.value)}
            required
          />
          <Field label="Location / service area" optional value={f.location} onChange={(e) => set("location", e.target.value)} />
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">B · Products / services</h2>
          <p className="type-caption text-ink-tertiary">
            Add each thing you sell. If you leave the price blank, the AI will never quote one — it will invite
            people to message you instead.
          </p>
          {f.products.map((p, i) => (
            <div key={i} className="space-y-3 rounded-md border border-strong p-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name" value={p.name} onChange={(e) => setProduct(i, { name: e.target.value })} />
                <Field label="Price" optional value={p.price} onChange={(e) => setProduct(i, { price: e.target.value })} />
              </div>
              <TextArea label="Description" value={p.description} onChange={(e) => setProduct(i, { description: e.target.value })} />
              <Field label="Main benefit" value={p.benefit} onChange={(e) => setProduct(i, { benefit: e.target.value })} />
              <Field label="URL" optional value={p.url} onChange={(e) => setProduct(i, { url: e.target.value })} />
              <button
                type="button"
                className="type-caption text-critical"
                onClick={() => setF((prev) => ({ ...prev, products: prev.products.filter((_, idx) => idx !== i) }))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="rounded-md border border-strong px-3 py-1.5 type-caption font-semibold"
            onClick={() => setF((prev) => ({ ...prev, products: [...prev.products, { ...EMPTY_PRODUCT }] }))}
          >
            + Add product / service
          </button>
          {f.products.length === 0 && (
            <TextArea
              label="Services / products (free text)"
              help="Only used if you don't add items above."
              value={f.services}
              onChange={(e) => set("services", e.target.value)}
              required
            />
          )}
          {namedProducts.length > 0 && (
            <div className="space-y-2">
              <p className="type-caption font-semibold text-ink-secondary">
                Which products/services should receive the most attention on social media?
              </p>
              <label className="flex items-center gap-2 type-body">
                <input type="radio" checked={f.focus_all} onChange={() => set("focus_all", true)} /> All equally
              </label>
              <label className="flex items-center gap-2 type-body">
                <input type="radio" checked={!f.focus_all} onChange={() => set("focus_all", false)} /> Select specific products/services
              </label>
              {!f.focus_all &&
                namedProducts.map((p) => (
                  <label key={p.name} className="ml-6 flex items-center gap-2 type-body">
                    <input
                      type="checkbox"
                      checked={f.focus_products.includes(p.name)}
                      onChange={(e) =>
                        set("focus_products", e.target.checked ? [...f.focus_products, p.name] : f.focus_products.filter((n) => n !== p.name))
                      }
                    />
                    {p.name}
                  </label>
                ))}
            </div>
          )}
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">C · Your audience</h2>
          <TagField label="Who are your ideal customers?" value={f.target_audience} onChange={(v) => set("target_audience", v)} />
          <TextArea
            label="What problems or needs do they have?"
            value={f.pain_points}
            onChange={(e) => set("pain_points", e.target.value)}
            placeholder="e.g. Too many repetitive customer questions; slow lead follow-up."
          />
          <TextArea
            label="What are they trying to achieve?"
            value={f.desired_outcomes}
            onChange={(e) => set("desired_outcomes", e.target.value)}
            placeholder="e.g. Save time, respond faster, get more bookings."
          />
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">D · Positioning</h2>
          <TextArea label="Why should customers choose you?" value={f.why_choose_us} onChange={(e) => set("why_choose_us", e.target.value)} />
          <TextArea label="What makes you different?" value={f.usps} onChange={(e) => set("usps", e.target.value)} />
          <TextArea
            label="Proof"
            optional
            help="Certifications, awards, testimonials, verified results, years of experience, achievements. Only what you list here can ever be cited as proof."
            value={f.proof}
            onChange={(e) => set("proof", e.target.value)}
          />
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">E · Brand</h2>
          <TagField label="Brand tone" value={f.tone_of_voice} onChange={(v) => set("tone_of_voice", v)} />
          <div className="flex flex-wrap gap-2">
            {TONES.filter((t) => !f.tone_of_voice.includes(t)).map((t) => (
              <button
                key={t}
                type="button"
                className="badge-base badge-neutral normal-case"
                onClick={() => set("tone_of_voice", [...f.tone_of_voice, t])}
              >
                + {t}
              </button>
            ))}
          </div>
          <Field label="Tagline" optional value={f.tagline} onChange={(e) => set("tagline", e.target.value)} />
          <TextArea
            label="Words / topics to avoid"
            optional
            help="Short words or phrases the AI must never use, separated by commas (e.g. cheap, guaranteed). Replies containing them are blocked."
            value={f.must_not_say}
            onChange={(e) => set("must_not_say", e.target.value)}
          />
          <Field label="Other things to avoid" optional value={f.negative_constraints} onChange={(e) => set("negative_constraints", e.target.value)} />
          <Field label="Visual style" optional placeholder="e.g. clean, bright, minimal" value={f.visual_style} onChange={(e) => set("visual_style", e.target.value)} />
          <TagField label="Brand colors" value={f.brand_colors} onChange={(v) => set("brand_colors", v)} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Language" optional value={f.language} onChange={(e) => set("language", e.target.value)} />
            <Field label="Emoji style" optional placeholder="minimal, expressive, none" value={f.emoji_style} onChange={(e) => set("emoji_style", e.target.value)} />
          </div>
          <TagField label="Caption styles" value={f.caption_styles} onChange={(v) => set("caption_styles", v)} />
          <Field label="Brand keywords / hashtag seeds" optional value={f.brand_keywords} onChange={(e) => set("brand_keywords", e.target.value)} />
          <TagField label="Themes you like (optional)" value={f.content_pillars} onChange={(v) => set("content_pillars", v)} />
          <p className="type-caption text-ink-tertiary">
            Logo upload isn&apos;t supported yet — the AI can&apos;t place a logo on generated images, so we don&apos;t ask for one.
          </p>
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">F · Social media goal</h2>
          <p className="type-caption text-ink-tertiary">Your AI uses this to decide the mix of educational, engaging and promotional posts.</p>
          <Select label="Primary goal" options={GOAL_OPTIONS} value={f.primary_goal} onChange={(e) => set("primary_goal", e.target.value)} />
          <Select label="Secondary goal" optional options={GOAL_OPTIONS} value={f.secondary_goal} onChange={(e) => set("secondary_goal", e.target.value)} />
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">G · Call to action</h2>
          <Select label="Primary CTA" options={CTA_OPTIONS} value={f.primary_cta} onChange={(e) => set("primary_cta", e.target.value)} />
          {cta?.needsDestination && <Field label={cta.needsDestination} value={f.cta_destination} onChange={(e) => set("cta_destination", e.target.value)} />}
          <Field
            label="Preferred CTA phrase"
            optional
            placeholder="e.g. DM us to discuss what you can automate."
            value={f.cta_phrase}
            onChange={(e) => set("cta_phrase", e.target.value)}
          />
          <TagField label="Other CTAs you're happy to use" value={f.preferred_ctas} onChange={(v) => set("preferred_ctas", v)} />
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">Additional knowledge (for AI replies)</h2>
          <TextArea
            label="FAQs"
            optional
            value={f.faqs}
            onChange={(e) => set("faqs", e.target.value)}
            placeholder={"Q: Do you offer weekend support?\nA: Yes, weekend support is available."}
          />
          <TextArea label="Offers" optional value={f.offers} onChange={(e) => set("offers", e.target.value)} />
          <TextArea
            label="General pricing information"
            optional
            help="Leave blank if pricing is custom/quote-based — the AI will invite people to message you instead of guessing."
            value={f.pricing_info}
            onChange={(e) => set("pricing_info", e.target.value)}
          />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Contact method" optional value={f.contact_method} onChange={(e) => set("contact_method", e.target.value)} />
            <Field label="Booking method" optional value={f.booking_method} onChange={(e) => set("booking_method", e.target.value)} />
          </div>
          <Field label="Business hours" optional value={f.business_hours} onChange={(e) => set("business_hours", e.target.value)} />
          <TextArea label="Must always say" optional value={f.must_say} onChange={(e) => set("must_say", e.target.value)} />
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">Lead generation — who you sell to</h2>
          <Field label="Target industry" optional value={f.icp_industry} onChange={(e) => set("icp_industry", e.target.value)} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Min employees" optional type="number" value={f.icp_min_employees} onChange={(e) => set("icp_min_employees", e.target.value)} />
            <Field label="Max employees" optional type="number" value={f.icp_max_employees} onChange={(e) => set("icp_max_employees", e.target.value)} />
          </div>
          <Field label="Target location" optional value={f.icp_location} onChange={(e) => set("icp_location", e.target.value)} />
        </section>

        <section className="panel panel-body space-y-4">
          <h2 className="type-subhead text-ink">Landing page</h2>
          <p className="type-caption text-ink-tertiary">
            A public page where ad clicks and link visitors can leave their details — submissions land
            directly in your Leads list.
          </p>
          <Field label="Page URL" optional placeholder="your-business-name" value={f.landing_slug} onChange={(e) => set("landing_slug", e.target.value)} />
          {slug && siteOrigin && (
            <p className="type-caption text-ink-tertiary">
              Your page:{" "}
              <a href={`${siteOrigin}/lp/${slug}`} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                {siteOrigin}/lp/{slug}
              </a>
            </p>
          )}
        </section>

        {error && <p className="type-caption text-critical">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-5 py-2.5 type-body font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : nextAfterSave ? "Save & continue" : "Save profile"}
          </button>
          {saved && <span className="type-caption text-positive">Saved</span>}
        </div>
      </form>
    </div>
  );
}
