// Circle Gateway — gasless instant USDC payments on Arc
// Docs: https://developers.circle.com/circle-mint/docs/gateway

export interface GatewayPayment {
  recipientAddress: string;
  amountUSDC: string;    // in human-readable USDC (e.g. "80.00")
  memo?: string;
}

export interface GatewayResult {
  txHash: string;
  settled: boolean;
  settledAt: number;
}

// Gateway endpoint for Arc
const GATEWAY_BASE_URL = import.meta.env.VITE_GATEWAY_URL ?? "https://api.circle.com/v1/gateway";
const GATEWAY_API_KEY = import.meta.env.VITE_CIRCLE_API_KEY ?? "";

export async function sendGatewayPayment(payment: GatewayPayment): Promise<GatewayResult> {
  // TODO: Implement Circle Gateway API call
  // Circle Gateway handles gas — no ETH/USDC for gas needed by agent wallet
  // Target settlement: <500ms
  throw new Error("Gateway integration — implement in Week 2");
}

export function formatUSDC(amount: string, decimals = 6): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

export function parseUSDC(raw: bigint, decimals = 6): string {
  const str = raw.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, -decimals);
  const fraction = str.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
