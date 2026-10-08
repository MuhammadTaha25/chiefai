import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";
import { getCallSettings, DEFAULTS, type CallSettings } from "@/lib/voice/call-settings";
import { formatInTimezone } from "@/lib/format-time";
import VoiceNumberPanel from "@/components/voice-number-panel";
import { getPinHash } from "@/lib/voice/pin";
import CallSettingsPanel from "@/components/call-settings-panel";

/**
 * The phone page: buy the number the world calls, and tell the agent which of
 * your own numbers to ring for the daily report. Both live here because they are
 * two halves of one feature and are easy to confuse otherwise.
 */
export default async function PhonePage() {
  const supabase = await createClient();
  const { client } = await getCurrentClient();

  const [{ data: numberRow }, { data: callRows }] = await Promise.all([
    client
      ? supabase
          .from("client_phone_numbers")
          .select("twilio_number, status")
          .eq("client_id", client.id)
          .eq("status", "active")
          .limit(1)
          .maybeSingle<{ twilio_number: string; status: string }>()
      : Promise.resolve({ data: null }),
    client
      ? supabase
          // Only columns that have always existed — the extra ones arrive with
          // supabase/add_voice_agent.sql and must not break this page before then.
          .from("client_calls")
          .select("id, direction, duration_seconds, transcript, created_at")
          .eq("client_id", client.id)
          .order("created_at", { ascending: false })
          .limit(15)
      : Promise.resolve({ data: null }),
  ]);

  // Call settings may live in the `clients` columns or, before the migration, in
  // auth metadata — getCallSettings() handles both.
  let settings: CallSettings | null = null;
  let settingsAvailable = true;
  let pinSet = false;
  if (client) {
    try {
      settings = await getCallSettings(createAdminClient(), client.id);
      pinSet = Boolean(await getPinHash(createAdminClient(), client.id).catch(() => null));
    } catch {
      settingsAvailable = false;
    }
  }

  // This page renders on the server, whose clock is UTC on Vercel — show times in the owner's own timezone.
  const displayTz = settings?.daily_call_timezone || DEFAULTS.daily_call_timezone;

  const calls = (callRows ?? []) as unknown as {
    id: string;
    direction: string | null;
    duration_seconds: number | null;
    transcript: string | null;
    created_at: string;
  }[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="type-title text-ink">Phone</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Buy a number your AI agent answers, then call it any time to ask about your business — leads, emails, replies,
          deals, social posts and ad budget. You can also have it ring you every day with the same report.
        </p>
      </div>

      <div className="panel panel-body space-y-2">
        <h2 className="text-lg font-semibold">Your AI phone number</h2>
        <p className="text-sm text-zinc-500">
          Nothing is bought for you automatically. Press the button when you want one — one number per account, bought
          from Twilio at the moment you ask for it. The number that is dialled decides whose data is read, never
          anything the caller says.
        </p>
        <div className="pt-2">
          <VoiceNumberPanel
            initialNumber={numberRow?.twilio_number ?? null}
            initialStatus={numberRow?.status ?? null}
          />
        </div>
      </div>

      <CallSettingsPanel
        initial={settings}
        available={settingsAvailable}
        numberActive={Boolean(numberRow)}
        pinSet={pinSet}
        hint="Daily-call settings could not be loaded. Please try again."
      />

      <div>
        <h2 className="text-lg font-semibold">Recent calls</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-black/[.08] dark:border-white/[.145]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/[.08] text-left text-xs text-zinc-500 dark:border-white/[.145]">
                <th className="px-4 py-3 font-medium">When ({displayTz})</th>
                <th className="px-4 py-3 font-medium">Direction</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Transcript</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-b border-black/[.06] last:border-0 dark:border-white/[.08]">
                  <td className="px-4 py-3 text-zinc-500">{formatInTimezone(c.created_at, displayTz)}</td>
                  <td className="px-4 py-3 capitalize">{c.direction ?? "—"}</td>
                  <td className="px-4 py-3">{c.duration_seconds != null ? `${c.duration_seconds}s` : "—"}</td>
                  <td className="px-4 py-3 text-zinc-500">{c.transcript ? `${c.transcript.slice(0, 60)}…` : "—"}</td>
                </tr>
              ))}
              {calls.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                    No calls yet. Call your number, or switch the daily report on above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
