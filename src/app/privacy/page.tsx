import Link from "next/link";
import { SITE } from "@/lib/seo";

export const metadata = {
  title: `Privacy Policy — ${SITE.name}`,
};

export default function PrivacyPage() {
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
          <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
          <p className="mt-2 text-sm text-zinc-500">Last updated {new Date().getFullYear()}</p>

          <div className="mt-8 space-y-6 rounded-xl border border-black/[.08] bg-white p-6 text-sm leading-relaxed text-zinc-700 dark:border-white/[.08] dark:bg-zinc-950 dark:text-zinc-300 sm:p-8">
            <p>
              {SITE.name} collects the business details you provide to configure
              lead generation, along with the lead and company data we find on
              your behalf, so we can run and improve the service for your account.
            </p>
            <p>
              We do not sell your data. Lead and company information is used only
              to power your account&apos;s search, outreach, and reporting features.
            </p>
            <p>
              <strong>Connected accounts and domains.</strong> If you connect social
              media accounts or a domain (purchased through us or one you already own),
              we store only what is needed to operate the connection: access tokens for
              social accounts, and DNS/mailbox configuration for domains. Domains you
              already own stay on your own DNS provider — we never take control of
              nameservers we don&apos;t manage, we only tell you which records to add.
            </p>
            <p>
              <strong>Security.</strong> Credentials and tokens for connected accounts
              are encrypted at rest. Access to your account data is limited to what is
              needed to provide the service.
            </p>
            <p>
              You can request export or deletion of your account data at any time
              through your account dashboard or by contacting support.
            </p>
          </div>

          <p className="mt-6 text-center text-sm text-zinc-500">
            See also our <Link href="/terms" className="font-medium underline">Terms and Conditions</Link>.
          </p>
        </div>
      </main>
    </div>
  );
}
