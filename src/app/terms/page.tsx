import { SITE } from "@/lib/seo";

export const metadata = {
  title: `Terms and Conditions — ${SITE.name}`,
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 sm:px-12">
      <h1 className="text-2xl font-semibold tracking-tight">Terms and Conditions</h1>
      <p className="mt-2 text-sm text-zinc-500">Last updated {new Date().getFullYear()}</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        <p>
          By using {SITE.name}, you agree to let us search for, contact, and store
          information about prospective business leads on your behalf, using the
          criteria you provide. You are responsible for ensuring your outreach
          complies with applicable laws, including anti-spam and data protection
          regulations in the regions you target.
        </p>
        <p>
          {SITE.name} finds and prepares leads automatically. No outreach message
          is sent without your review and approval. You remain in control of what
          is sent, to whom, and when.
        </p>
        <p>
          <strong>Connected accounts.</strong> You may connect third-party accounts
          to {SITE.name}, including social media accounts for posting and
          messaging, and a domain (either purchased through us or one you already
          own, by pointing its DNS to the records we provide) for sending and
          receiving email. You authorize us to act on these connected accounts
          only for the purposes you configure, and you can disconnect any of them
          at any time from your account settings.
        </p>
        <p>
          <strong>Data security.</strong> We apply reasonable administrative,
          technical, and organizational safeguards to protect the data in your
          account, including lead data, connected-account credentials, and domain
          and DNS information. Credentials for connected accounts are encrypted at
          rest and are never shared with other users.
        </p>
        <p>
          We may update these terms from time to time. Continued use of the
          service after a change constitutes acceptance of the updated terms.
        </p>
        <p>
          Questions about these terms can be sent to our support team through
          your account dashboard.
        </p>
      </div>
    </div>
  );
}
