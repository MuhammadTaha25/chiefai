"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      className="w-full rounded-md border border-black/[.1] px-2 py-1.5 text-left text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-white/[.145] dark:text-zinc-400 dark:hover:bg-zinc-900"
    >
      Log out
    </button>
  );
}
