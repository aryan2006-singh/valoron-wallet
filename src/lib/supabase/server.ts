import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server-side client for use inside Route Handlers and Server Components.
// Resolves the acting user from the request's session cookie -- this is the
// ONLY source of truth for "who is calling," never a value from the request
// body.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component render -- safe to ignore since
            // middleware refreshes the session on every request.
          }
        },
      },
    }
  );
}
