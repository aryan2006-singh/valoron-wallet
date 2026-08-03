import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Server-only, service-role client. Bypasses Row Level Security entirely.
// NEVER import this from a Client Component or anything that could end up
// in the browser bundle -- it must only be referenced from Route Handlers
// that run exclusively on the server (the two webhook handlers, plus
// audit-log writes for rejected attempts).
export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
