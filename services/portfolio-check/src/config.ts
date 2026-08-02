import "dotenv/config";
import { defineChain } from "viem";

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
  circleApiKey: process.env.CIRCLE_API_KEY?.trim() || "",
  circleEntitySecret: process.env.CIRCLE_ENTITY_SECRET?.trim() || "",
  serviceWalletId: process.env.SERVICE_WALLET_ID?.trim() || "",
  serviceWalletAddress: (process.env.SERVICE_WALLET_ADDRESS?.trim() || "") as `0x${string}` | "",
  circleBlockchain: process.env.CIRCLE_BLOCKCHAIN?.trim() || "ARC-TESTNET",
  gatewayFacilitatorUrl: process.env.GATEWAY_FACILITATOR_URL?.trim() || "https://gateway-api-testnet.circle.com",
  fee: process.env.PORTFOLIO_CHECK_FEE?.trim() || "0.01",
  port: Number(process.env.PORT ?? 8788),
};
