import { createRequire } from "node:module";
import { createWalletClient, custom, type WalletClient } from "viem";
import { config, arcTestnet } from "../config.js";

// The Circle Developer-Controlled Wallets `/evm` subpath ships dual CJS/ESM builds,
// and its ESM named exports aren't reliably resolvable across Node versions — a
// static `import { createEIP1193Provider }` works on some Node versions but throws
// on others with "does not provide an export named 'createEIP1193Provider'". Load
// the CJS build explicitly via createRequire so the export is found deterministically.
// (This exact failure — and this fix — is documented in the Foreman project's Circle
// feedback notes from the same author; reused here rather than re-discovering it.)
const nodeRequire = createRequire(import.meta.url);
const { createEIP1193Provider } = nodeRequire(
  "@circle-fin/developer-controlled-wallets/evm",
) as typeof import("@circle-fin/developer-controlled-wallets/evm");

/**
 * Custody via Circle Programmable Wallets (developer-controlled, MPC).
 *
 * Circle holds the key shares — Patron NEVER sees a raw private key. Circle's
 * EIP-1193 provider drives the MPC wallet over the API; wrapped in a viem
 * WalletClient so the Agent Wallet can both:
 *   • sign x402 payment authorizations (EIP-712 `signTypedData`) — this is exactly
 *     the `BatchEvmSigner` shape the Gateway batching rail needs, so payments run
 *     under MPC, and
 *   • send arbitrary contract-write transactions on Arc — including SecureFlow's
 *     `createEscrow` / `acceptFreelancer` / `approveMilestone` — via `writeContract`,
 *     which works for any ABI (arrays, strings, structs) since it's just ABI-encoded
 *     calldata under the hood. This is what de-risks Phase 0 Spike A: a Circle
 *     Programmable Wallet CAN execute SecureFlow's complex writes, no hybrid
 *     viem-hot-wallet fallback needed.
 *
 * Shape matches `BatchEvmSigner` from @circle-fin/x402-batching: `{ address, signTypedData }`.
 */
export interface CircleSigner {
  readonly address: `0x${string}`;
  signTypedData: (params: {
    domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
  /** viem client bound to the MPC wallet — for on-chain txs (SecureFlow writes, Gateway deposit/withdraw). */
  readonly walletClient: WalletClient;
}

export function circleCustodyReady(): boolean {
  return !!(config.circleApiKey && config.circleEntitySecret && config.circleWalletAddress);
}

/** Build an MPC-backed signer for the Patron Agent Wallet. Throws if Circle isn't configured. */
export function createCircleSigner(): CircleSigner {
  if (!config.circleApiKey || !config.circleEntitySecret) {
    throw new Error("Circle custody needs CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in daemon/.env");
  }
  if (!config.circleWalletAddress) {
    throw new Error("Circle custody needs CIRCLE_WALLET_ADDRESS — run `npm run circle:setup` first");
  }

  const provider = createEIP1193Provider({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    chain: config.circleBlockchain as Parameters<typeof createEIP1193Provider>[0]["chain"],
  });
  const address = config.circleWalletAddress as `0x${string}`;
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
