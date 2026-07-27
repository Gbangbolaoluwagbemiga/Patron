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
  buyerWalletId: process.env.BUYER_WALLET_ID?.trim() || "",
  buyerWalletAddress: (process.env.BUYER_WALLET_ADDRESS?.trim() || "") as `0x${string}` | "",
  circleBlockchain: process.env.CIRCLE_BLOCKCHAIN?.trim() || "ARC-TESTNET",
  patronUrl: process.env.PATRON_URL?.trim() || "http://localhost:8787",
};
