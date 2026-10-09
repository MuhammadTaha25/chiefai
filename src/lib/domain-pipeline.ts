/**
 * Pure mapping from what is actually recorded (domain_purchases.status, domains.dns_status, mailbox
 * readiness) to the stages the Domains page shows. Nothing here reads a provider or writes state; a stage is
 * only "done" when the stored, provider-verified state says so.
 */
export type StageState = "done" | "active" | "pending" | "failed";

export interface PipelineStage {
  key: "payment" | "registration" | "dns" | "mailboxes";
  label: string;
  state: StageState;
  detail?: string;
}

export interface DomainPipeline {
  domain: string;
  purchaseId: string;
  stages: PipelineStage[];
  /** True while something is still expected to change on its own (keep polling). */
  inProgress: boolean;
}

export interface PipelineInput {
  domain: string;
  purchaseId: string;
  purchaseStatus: string;
  lastError: string | null;
  /** domains.dns_status for this domain, or null when no domains row exists yet. */
  dnsStatus: string | null;
  /** Readiness of each mailbox on this domain ("ready" = its Mailgun domain is verified). */
  mailboxReadiness: string[];
}

export function buildDomainPipeline(i: PipelineInput): DomainPipeline {
  const s = i.purchaseStatus;
  const paid = !["pending_payment", "payment_failed"].includes(s);
  const registered = s === "registered";

  const payment: PipelineStage =
    s === "payment_failed"
      ? { key: "payment", label: "Payment", state: "failed", detail: "Payment did not go through — no charge was made." }
      : paid
        ? { key: "payment", label: "Payment", state: "done" }
        : { key: "payment", label: "Payment", state: "active", detail: "Waiting for payment confirmation." };

  let registration: PipelineStage;
  if (registered) registration = { key: "registration", label: "Domain registered at Hostinger", state: "done" };
  else if (s === "registration_failed")
    registration = {
      key: "registration",
      label: "Domain registered at Hostinger",
      state: "failed",
      detail: i.lastError ? "Registration failed — it will be retried automatically." : "Registration failed.",
    };
  else if (s === "paid" || s === "registering")
    registration = {
      key: "registration",
      label: "Domain registered at Hostinger",
      state: "active",
      detail: i.lastError ?? "Registering — the registry confirms this in a few minutes.",
    };
  else registration = { key: "registration", label: "Domain registered at Hostinger", state: "pending" };

  let dns: PipelineStage;
  if (!registered) dns = { key: "dns", label: "DNS + Mailgun verification", state: "pending" };
  else if (i.dnsStatus === "active") dns = { key: "dns", label: "DNS + Mailgun verification", state: "done" };
  else if (i.dnsStatus === "provisioning_failed")
    dns = { key: "dns", label: "DNS + Mailgun verification", state: "failed", detail: "DNS records could not be confirmed — retrying automatically." };
  else dns = { key: "dns", label: "DNS + Mailgun verification", state: "active", detail: "DNS is propagating; Mailgun is re-checking." };

  const readyCount = i.mailboxReadiness.filter((r) => r === "ready").length;
  const sandboxCount = i.mailboxReadiness.filter((r) => r === "sandbox").length;
  let mailboxes: PipelineStage;
  if (dns.state !== "done") mailboxes = { key: "mailboxes", label: "Mailboxes ready to send", state: "pending" };
  else if (sandboxCount > 0)
    // A sandbox domain reports as send-capable on Mailgun's side but only delivers to a short list of
    // pre-approved test addresses — treat it as a failure, not "done", so it can't be mistaken for a
    // working mailbox and used for real campaign sends.
    mailboxes = {
      key: "mailboxes",
      label: "Mailboxes ready to send",
      state: "failed",
      detail: "This Mailgun account is still on a sandbox domain — it can only deliver to pre-approved test addresses. Add a real domain in Mailgun before sending campaigns.",
    };
  else if (readyCount > 0)
    mailboxes = { key: "mailboxes", label: "Mailboxes ready to send", state: "done", detail: `${readyCount} of ${i.mailboxReadiness.length} ready` };
  else mailboxes = { key: "mailboxes", label: "Mailboxes ready to send", state: "active", detail: i.mailboxReadiness.length ? "Mailbox domain is still verifying." : "Add a mailbox below." };

  const stages = [payment, registration, dns, mailboxes];
  // A mailbox stage waiting on the user ("Add a mailbox") does not need polling; everything else in flight does.
  const inProgress = stages.some((st) => st.state === "active" && !(st.key === "mailboxes" && i.mailboxReadiness.length === 0)) ||
    (registered === false && s !== "payment_failed" && s !== "registration_failed" && s !== "pending_payment");
  return { domain: i.domain, purchaseId: i.purchaseId, stages, inProgress };
}
