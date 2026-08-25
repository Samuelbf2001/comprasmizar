import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "../database.types";
import { runtimeEnv } from "../security/env";

/** Browser-equivalent server client: honors the user's cookies and therefore RLS. */
export async function createSupabaseUserClient() {
  const env = runtimeEnv(), store = await cookies();
  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { cookies: { getAll: () => store.getAll(), setAll: (items) => { try { items.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* Route handlers may be read-only. */ } } } });
}
/** Service client is server-only; never pass it to UI or use it for actor-scoped reads. */
export function createSupabaseServiceClient() { const env = runtimeEnv(); return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } }); }
