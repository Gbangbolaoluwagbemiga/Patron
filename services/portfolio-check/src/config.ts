import "dotenv/config";
import { defineChain } from "viem";

export const rpcUrl = process.env.ARC_RPC_URL?.trim() || "https://rpc.mainnet.arc.io";

export const arcTestnet = defineChain({
  id: Number(process.env.ARC_CHAIN_ID ?? 5042),
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Arc Explorer", url: process.env.ARC_EXPLORER_URL?.trim() || "https://explorer.arc.io" } },
  testnet: Number(process.env.ARC_CHAIN_ID ?? 5042) !== 5042,
});

export const config = {
  circleApiKey: process.env.CIRCLE_API_KEY?.trim() || "",
  circleEntitySecret: process.env.CIRCLE_ENTITY_SECRET?.trim() || "",
  serviceWalletId: process.env.SERVICE_WALLET_ID?.trim() || "",
  serviceWalletAddress: (process.env.SERVICE_WALLET_ADDRESS?.trim() || "") as `0x${string}` | "",
  circleBlockchain: process.env.CIRCLE_BLOCKCHAIN?.trim() || "ARC",
  gatewayFacilitatorUrl: process.env.GATEWAY_FACILITATOR_URL?.trim() || "https://gateway-api.circle.com",
  fee: process.env.PORTFOLIO_CHECK_FEE?.trim() || "0.01",
  port: Number(process.env.PORT ?? 8788),
};
