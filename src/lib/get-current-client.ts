import { createClient } from "@/lib/supabase/server";

/**
 * Resolves the logged-in user's `clients` row server-side.
 * Use this everywhere a client_id is needed instead of trusting one from the request body.
 */
export async function getCurrentClient() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, client: null, supabase };

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("auth_user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return { user, client, supabase };
}
