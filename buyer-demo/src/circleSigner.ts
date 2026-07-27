// circleSigner.ts — same pattern as daemon/src/circle/circleSigner.ts, pointed at
// the buyer's own dedicated Circle Agent Wallet instead of Patron's. This is the
// "customer" in the demo: it has its own on-chain identity, its own MPC key shares
// held by Circle, and pays Patron the same way any real agent-marketplace customer
// would — no human, no raw private key.
import { createRequire } from "node:module";
import { createWalletClient, custom, type WalletClient } from "viem";
import { config, arcTestnet } from "./config.js";

const nodeRequire = createRequire(import.meta.url);
const { createEIP1193Provider } = nodeRequire(
  "@circle-fin/developer-controlled-wallets/evm",
) as typeof import("@circle-fin/developer-controlled-wallets/evm");

export interface CircleSigner {
  readonly address: `0x${string}`;
  signTypedData: (params: {
    domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
  readonly walletClient: WalletClient;
}

export function createBuyerSigner(): CircleSigner {
  if (!config.circleApiKey || !config.circleEntitySecret) {
    throw new Error("Buyer demo needs CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in buyer-demo/.env");
  }
  if (!config.buyerWalletAddress) {
    throw new Error("Buyer demo needs BUYER_WALLET_ADDRESS — run `npm run wallet:setup` first");
  }

  const provider = createEIP1193Provider({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    chain: config.circleBlockchain as Parameters<typeof createEIP1193Provider>[0]["chain"],
  });
  const address = config.buyerWalletAddress as `0x${string}`;
  const walletClient = createWalletClient({
    account: address,
    chain: arcTestnet,
    transport: custom(provider as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }),
  });

  return {
    address,
    walletClient,
    signTypedData: (params) =>
      (walletClient.signTypedData as (a: unknown) => Promise<`0x${string}`>)({
        account: address,
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message,
      }),
  };
}
