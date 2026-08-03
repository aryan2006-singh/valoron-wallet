import { createBrowserClient } from "@supabase/ssr";

// Browser client. Uses the publishable key only -- safe to ship to the
// client bundle. Every read/write made through this client is still subject
// to Row Level Security and the money functions' own EXECUTE grants.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
