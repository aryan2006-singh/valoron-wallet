import { createHmac } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasOnlyAllowedKeys, isUuid } from "@/lib/api-helpers";

// Stands in for a real payment gateway's dashboard/API. A live gateway
// (Razorpay/Stripe/etc.) would call our /api/webhooks/payment endpoint
// itself once the user actually paid; here we construct and sign that same
// webhook call ourselves, server-side, using the secret that only server
// code ever holds. The browser never sees PAYMENT_WEBHOOK_SECRET, and this
// route does not credit anything directly -- it only forges what a real
// provider would send, and the *real* verification path in
// /api/webhooks/payment is what actually performs the credit.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !hasOnlyAllowedKeys(body as Record<string, unknown>, ["intentId"])
  ) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { intentId } = body as Record<string, unknown>;
  if (!isUuid(intentId)) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { data: intent, error } = await supabase
    .from("payment_intents")
    .select("id, amount_paise, user_id")
    .eq("id", intentId)
    .single();

  if (error || !intent || intent.user_id !== user.id) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  const payload = {
    event: "payment.captured",
    payment_id: `pay_${crypto.randomUUID()}`,
    intent_id: intent.id,
    amount_paise: intent.amount_paise,
    timestamp: Math.floor(Date.now() / 1000),
  };

  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", process.env.PAYMENT_WEBHOOK_SECRET!).update(rawBody).digest("hex");

  // Call the webhook route via localhost, not the public URL. A server
  // fetching its own public HTTPS hostname from inside itself is a classic
  // "hairpin" failure on platforms like Render (the request loops back
  // through the edge proxy/TLS termination and can fail outright) --
  // localhost avoids that network hop entirely while still exercising the
  // real route handler and its signature verification.
  const webhookUrl = `http://127.0.0.1:${process.env.PORT ?? 3000}/api/webhooks/payment`;
  const webhookResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": signature },
    body: rawBody,
  });

  const webhookResult = await webhookResponse.json();
  return NextResponse.json(webhookResult, { status: webhookResponse.status });
}
