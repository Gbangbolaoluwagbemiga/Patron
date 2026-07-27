// x402-client.ts — the buyer side of the same protocol Patron's seller middleware
// speaks (daemon/src/circle/x402-seller.ts). Adapted from daemon/src/circle/gateway.ts's
// `pay()` — same Gateway-batching flow, trimmed to just what a standalone buyer needs:
// no treasury deposit/withdraw, just "discover a paywall, get 402, sign, pay."
import { formatUnits } from "viem";
import { BatchEvmScheme, CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";
import { createBuyerSigner } from "./circleSigner.js";

export interface PaidResult<T> {
  data: T;
  amount: bigint;
  formattedAmount: string;
  transaction: string;
  status: number;
}

export async function payForHire<T = unknown>(
  url: string,
  body: unknown,
  onStep?: (step: string) => void,
): Promise<PaidResult<T>> {
  const signer = createBuyerSigner();
  const scheme = new BatchEvmScheme(signer);
  const chainConfig = CHAIN_CONFIGS.arcTestnet;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const serializedBody = JSON.stringify(body);

  onStep?.(`Discovering ${url} …`);
  const initial = await fetch(url, { method: "POST", headers, body: serializedBody });

  if (initial.status !== 402) {
    if (initial.ok) {
      return { data: (await initial.json()) as T, amount: 0n, formattedAmount: "0", transaction: "", status: initial.status };
    }
    throw new Error(`Request failed with status ${initial.status}: ${await initial.text()}`);
  }

  onStep?.("Got 402 Payment Required — reading the payment terms …");
  const prHeader = initial.headers.get("PAYMENT-REQUIRED");
  if (!prHeader) throw new Error("Missing PAYMENT-REQUIRED header in 402 response");
  const paymentRequired = JSON.parse(Buffer.from(prHeader, "base64").toString("utf-8"));
  const accepts: Array<Record<string, unknown>> = paymentRequired.accepts ?? [];
  if (accepts.length === 0) throw new Error("No payment options in 402 response");

  const expectedNetwork = `eip155:${chainConfig.chain.id}`;
  const batchingOption = accepts.find((opt) => {
    const extra = opt.extra as Record<string, unknown> | undefined;
    return (
      opt.network === expectedNetwork &&
      extra?.name === "GatewayWalletBatched" &&
      extra?.version === "1" &&
      typeof extra?.verifyingContract === "string"
    );
  });
  if (!batchingOption) throw new Error(`No Gateway batching option for ${expectedNetwork} — seller may not support Arc.`);

  const amount = BigInt((batchingOption as { amount: string }).amount);
  onStep?.(`Terms: $${formatUnits(amount, 6)} USDC to ${batchingOption.payTo} — signing via Circle MPC (no raw key) …`);

  const paymentPayload = await scheme.createPaymentPayload(paymentRequired.x402Version ?? 2, batchingOption as never);
  const paymentHeader = Buffer.from(
    JSON.stringify({ ...paymentPayload, resource: paymentRequired.resource, accepted: batchingOption }),
  ).toString("base64");

  onStep?.("Signed. Retrying with the payment authorization attached …");
  const paid = await fetch(url, { method: "POST", headers: { ...headers, "Payment-Signature": paymentHeader }, body: serializedBody });
  if (!paid.ok) {
    const err = (await paid.json().catch(() => ({}))) as { error?: string; reason?: string; message?: string };
    throw new Error(`Payment failed: ${err.error || paid.statusText}${err.reason ? ` (${err.reason})` : ""}${err.message ? ` — ${err.message}` : ""}`);
  }

  const data = (await paid.json()) as T;
  let transaction = "";
  const respHeader = paid.headers.get("PAYMENT-RESPONSE");
  if (respHeader) {
    const settle = JSON.parse(Buffer.from(respHeader, "base64").toString("utf-8"));
    transaction = settle.transaction ?? "";
  }
  return { data, amount, formattedAmount: formatUnits(amount, 6), transaction, status: paid.status };
}
