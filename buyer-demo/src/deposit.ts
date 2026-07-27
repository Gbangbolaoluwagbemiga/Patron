// deposit.ts — one-time step before the buyer can actually pay over x402: Circle's
// Gateway batching settles against a balance DEPOSITED into the GatewayWallet
// contract, not just whatever the wallet holds natively. Signing an EIP-3009
// authorization without this deposit is why the first live run failed with
// `insufficient_balance` even though the wallet had native currency.
//
//   npm run deposit -- 1        (deposits 1 USDC-equivalent)
import { erc20Abi, parseUnits } from "viem";
import { CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";
import { arcTestnet } from "./config.js";
import { createBuyerSigner } from "./circleSigner.js";
import { createPublicClient, http } from "viem";

const GATEWAY_WALLET_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

async function main() {
  const amountArg = process.argv[2] ?? "1";
  const chainConfig = CHAIN_CONFIGS.arcTestnet;
  const signer = createBuyerSigner();
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
  const depositAmount = parseUnits(amountArg, 6);

  console.log(`→ Depositing ${amountArg} USDC into Circle's GatewayWallet for ${signer.address}…`);

  const allowance = (await publicClient.readContract({
    address: chainConfig.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [signer.address, chainConfig.gatewayWallet],
  })) as bigint;

  if (allowance < depositAmount) {
    console.log("  approving…");
    const approveHash = await signer.walletClient.writeContract({
      chain: arcTestnet,
      account: signer.address,
      address: chainConfig.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [chainConfig.gatewayWallet, depositAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const depositHash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: chainConfig.gatewayWallet,
    abi: GATEWAY_WALLET_ABI,
    functionName: "deposit",
    args: [chainConfig.usdc, depositAmount],
    gas: 120_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });

  console.log(`✅ Deposited ${amountArg} USDC — tx ${depositHash}`);
}

main().catch((e) => {
  console.error("✗ deposit failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
