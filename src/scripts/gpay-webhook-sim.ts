// src/scripts/gpay-webhook-sim.ts
//
// Local GPay webhook simulator.
//
// Signs a payload exactly the way GPay does (HMAC-SHA256 of the raw body using
// GPAY_WEBHOOK_SECRET) and POSTs it to our own webhook endpoint. This lets the
// signature-verification, idempotency and amount-guard paths be exercised
// without a public URL or a real Mastercard payment.
//
// Usage (dev server running, credentials in .env):
//   npx ts-node src/scripts/gpay-webhook-sim.ts --reference=PAY-XXXX
//   npx ts-node src/scripts/gpay-webhook-sim.ts --reference=PAY-XXXX --encoding=base64
//   npx ts-node src/scripts/gpay-webhook-sim.ts --reference=PAY-XXXX --amount=500.00      # amount tamper → no confirm
//   npx ts-node src/scripts/gpay-webhook-sim.ts --reference=PAY-XXXX --bad-signature      # expect HTTP 401
//   npx ts-node src/scripts/gpay-webhook-sim.ts --reference=PAY-XXXX --status=failed      # expect pending, no confirm
//   npx ts-node src/scripts/gpay-webhook-sim.ts --reference=PAY-XXXX --event=charge.failed
//
// Run it twice with the same reference to prove duplicate deliveries are ignored.

import "dotenv/config";
import crypto from "crypto";

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? "" : undefined;
}

async function main() {
  const reference = flag("reference");
  if (!reference) {
    console.error(
      "Missing --reference=<merchant_transaction_ref>. Use the `reference` returned by the initiate endpoint (it is also stored on the PaymentIntent row).",
    );
    process.exit(1);
  }

  const secret = process.env.GPAY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error(
      "GPAY_WEBHOOK_SECRET is not set in .env — cannot sign the payload.",
    );
    process.exit(1);
  }

  const url =
    flag("url")?.trim() ||
    process.env.GPAY_WEBHOOK_URL?.trim() ||
    "http://localhost:3006/api/v1/payments/gpay/webhook";
  const encoding = (flag("encoding") ?? "hex").toLowerCase();
  const digest = encoding === "base64" ? "base64" : "hex";
  const amount = flag("amount") ?? "100.00";
  const status = flag("status") ?? "successful";
  const event = flag("event") ?? "charge.success";
  const tamperSignature = process.argv.includes("--bad-signature");

  const gpayReference = `GPAY_MC_SIM_${Date.now()}`;

  // Same shape as GPay's documented webhook payload.
  const payload = {
    event,
    data: {
      gpay_reference: gpayReference,
      merchant_transaction_ref: reference,
      status,
      amount,
      currency: "NGN",
      gateway_name: "Mastercard MPGS",
      gateway_reference: "AUTH_SIM_000001",
      order_id: gpayReference,
      mastercard_session_id: "SESSION0002951568084F81658240J7",
      paid_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    },
  };

  // Sign the EXACT bytes we send — GPay signs the raw body, not a re-serialised copy.
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest(digest);

  const sentSignature = tamperSignature
    ? crypto
        .createHmac("sha256", secret)
        .update(Buffer.from(`${rawBody.toString("utf8")} `, "utf8"))
        .digest(digest)
    : signature;

  console.log(`POST ${url}`);
  console.log(`  reference : ${reference}`);
  console.log(`  gpay_ref  : ${gpayReference}`);
  console.log(`  event     : ${event}`);
  console.log(`  status    : ${status}`);
  console.log(`  amount    : ${amount}`);
  console.log(`  encoding  : ${digest}${tamperSignature ? " (deliberately tampered)" : ""}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GPay-Signature": sentSignature,
    },
    body: rawBody,
  });

  const text = await res.text();
  console.log(`→ HTTP ${res.status} ${text}`);
  console.log(
    "Check the server logs for [gpay.webhook] lines to see how it was handled.",
  );
}

main().catch((err) => {
  console.error("Simulator failed:", err);
  process.exit(1);
});
