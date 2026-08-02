// circleSigner.ts — same MPC-wallet pattern as daemon/src/circle/circleSigner.ts
// and buyer-demo/src/circleSigner.ts, pointed at this service's own dedicated
// wallet. This is the seller side of the x402 call Patron makes — a genuinely
// separate on-chain identity, not Patron's treasury paying itself.
import { createRequire } from "node:module";
import { createWalletClient, custom, type WalletClient } from "viem";
import { config, arcTestnet } from "./config.js";

const nodeRequire = createRequire(import.meta.url);
const { createEIP1193Provider } = nodeRequire(
  "@circle-fin/developer-controlled-wallets/evm",
) as typeof import("@circle-fin/developer-controlled-wallets/evm");

export interface CircleSigner {
  readonly address: `0x${string}`;
  readonly walletClient: WalletClient;
}

export function createServiceSigner(): CircleSigner {
  if (!config.circleApiKey || !config.circleEntitySecret) {
    throw new Error("portfolio-check needs CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in services/portfolio-check/.env");
  }
  if (!config.serviceWalletAddress) {
    throw new Error("portfolio-check needs SERVICE_WALLET_ADDRESS — run `npm run wallet:setup` first");
  }

  const provider = createEIP1193Provider({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    chain: config.circleBlockchain as Parameters<typeof createEIP1193Provider>[0]["chain"],
  });
  const address = config.serviceWalletAddress as `0x${string}`;
  const walletClient = createWalletClient({
    account: address,
    chain: arcTestnet,
    transport: custom(provider as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }),
  });

  return { address, walletClient };
}
