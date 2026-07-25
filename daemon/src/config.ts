import "dotenv/config";
import { defineChain } from "viem";

/** Arc Testnet — Circle's stablecoin-native L1. USDC is the native currency (6 decimals). */
export const rpcUrl = process.env.ARC_RPC_URL?.trim() || "https://rpc.drpc.testnet.arc.network";

export const arcTestnet = defineChain({
  id: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",

  // SecureFlow — Patron calls this contract, does NOT deploy its own
  secureflowAddress: (process.env.SECUREFLOW_CONTRACT_ADDRESS?.trim() ||
    "0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59") as `0x${string}`,
  usdcAddress: (process.env.USDC_ADDRESS?.trim() ||
    "0x3600000000000000000000000000000000000000") as `0x${string}`,
  graphUrl: process.env.GRAPH_URL?.trim() || "",

  // Circle Programmable Wallets (MPC) — the Patron Agent Wallet treasury.
  circleApiKey: process.env.CIRCLE_API_KEY?.trim() || "",
  circleEntitySecret: process.env.CIRCLE_ENTITY_SECRET?.trim() || "",
  circleWalletId: process.env.CIRCLE_WALLET_ID?.trim() || "",
  circleWalletAddress: (process.env.CIRCLE_WALLET_ADDRESS?.trim() || "") as `0x${string}` | "",
  circleBlockchain: process.env.CIRCLE_BLOCKCHAIN?.trim() || "ARC-TESTNET",

  // Circle Gateway (x402 nanopayments)
  gatewayFacilitatorUrl:
    process.env.GATEWAY_FACILITATOR_URL?.trim() || "https://gateway-api-testnet.circle.com",
  x402OrderFee: process.env.X402_ORDER_FEE?.trim() || "0.05",

  // Application-level spending policy — the second cage. The Developer-Controlled
  // Wallets SDK has no native policy engine, so Patron enforces caps itself before
  // every signed spend (see circle/gateway.ts).
  dailySpendCapUsdc: Number(process.env.DAILY_SPEND_CAP_USDC ?? 50),
  x402BuySpendCapUsdc: Number(process.env.X402_BUY_SPEND_CAP_USDC ?? 5),

  port: Number(process.env.PORT ?? 8787),
};

/** USDC on Arc Testnet has 6 decimals. */
export const USDC_DECIMALS = 6;
