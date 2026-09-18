/**
 * Read-only mainnet verification. Costs nothing, writes nothing.
 *
 *   SECUREFLOW_ADDRESS=0x... npx tsx scripts/verify-mainnet.ts
 *
 * Run it after deploying, after whitelisting, and again after funding. Every
 * check is a question we got wrong at least once on testnet: is this really
 * mainnet, does the contract actually exist at that address, is USDC actually
 * whitelisted (a job silently fails to post if not), and does the treasury hold
 * enough to both pay gas and fund an escrow.
 */
import { createPublicClient, http, formatUnits, formatEther } from "viem";
import abiJson from "../src/web3/SecureFlowABI.json" with { type: "json" };

const abi = abiJson as any;
const RPC = process.env.ARC_RPC_URL?.trim() || "https://rpc.mainnet.arc.io";
const USDC = "0x3600000000000000000000000000000000000000" as `0x${string}`;
const SF = (process.env.SECUREFLOW_ADDRESS ?? process.env.SECUREFLOW_CONTRACT_ADDRESS ?? "").trim() as `0x${string}`;
const TREASURY = (process.env.CIRCLE_WALLET_ADDRESS ?? "").trim() as `0x${string}`;

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const pc = createPublicClient({ transport: http(RPC, { timeout: 20_000 }) });
const erc = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const chainId = await pc.getChainId();
t("connected to Arc mainnet", chainId === 5042, `chainId ${chainId}`);

if (!SF) {
  console.log("\n  SECUREFLOW_ADDRESS not set — pass it once the contract is deployed.");
  process.exit(1);
}

const code = await pc.getCode({ address: SF });
t("contract exists at that address", !!code && code !== "0x", `${SF} (${code ? (code.length - 2) / 2 : 0} bytes)`);

const read = async (fn: string, args: any[] = []) => {
  try { return await pc.readContract({ address: SF, abi, functionName: fn, args }); } catch { return undefined; }
};

const owner = await read("owner");
t("owner is set", !!owner, String(owner));
const feeBP = await read("platformFeeBP");
t("platform fee is 1%", Number(feeBP) === 100, `${Number(feeBP)} bp — matches the live testnet contract and the copy shown to freelancers`);
const collector = await read("feeCollector");
if (collector) console.log(`        fee collector: ${collector}`);

const whitelisted = await read("whitelistedTokens", [USDC]);
t("USDC is whitelisted", whitelisted === true, whitelisted === true ? "jobs can be posted" : "createEscrow WILL revert until whitelisted");

const nextId = await read("nextEscrowId");
console.log(`        next escrow id: ${nextId ?? "?"}`);

if (TREASURY) {
  const nat = await pc.getBalance({ address: TREASURY });
  const bal = await pc.readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [TREASURY] });
  console.log(`\n  treasury ${TREASURY}`);
  console.log(`        native (gas) : ${formatEther(nat)}`);
  console.log(`        USDC         : ${formatUnits(bal as bigint, 6)}`);
  t("treasury can pay gas", nat > 0n);
  t("treasury can fund a $0.20 job", (bal as bigint) >= 205_000n, `needs ~0.205 incl. 2.5% fee`);
} else {
  console.log("\n  CIRCLE_WALLET_ADDRESS not set — skipping treasury checks.");
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
