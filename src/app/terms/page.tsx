import Link from "next/link";
import { SITE } from "@/lib/seo";

export const metadata = {
  title: `Terms and Conditions — ${SITE.name}`,
};

export default function TermsPage() {
  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between px-6 py-5 sm:px-12">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          {SITE.name}
        </Link>
        <Link href="/" className="text-sm font-medium text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100">
          Back to home
        </Link>
      </header>

      <main className="flex flex-1 justify-center px-6 pb-20 sm:px-12">
        <div className="w-full max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight">Terms and Conditions</h1>
          <p className="mt-2 text-sm text-zinc-500">Last updated {new Date().getFullYear()}</p>

          <div className="mt-8 space-y-6 rounded-xl border border-black/[.08] bg-white p-6 text-sm leading-relaxed text-zinc-700 dark:border-white/[.08] dark:bg-zinc-950 dark:text-zinc-300 sm:p-8">
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

          <p className="mt-6 text-center text-sm text-zinc-500">
            See also our <Link href="/privacy" className="font-medium underline">Privacy Policy</Link>.
          </p>
        </div>
      </main>
    </div>
  );
}
