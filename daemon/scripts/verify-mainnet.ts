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
import "dotenv/config";
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

/*
 * IS THIS THE CONTRACT WE THINK IT IS?
 *
 * Every check above passes identically against a fresh non-upgradeable deploy
 * and against the UUPS proxy we actually run — same owner, same fee, same
 * whitelist. So they cannot tell us whether the address holds the implementation
 * whose source we built this ABI from.
 *
 * That is not hypothetical: this repo shipped for weeks with an ABI from an
 * intermediate build, missing version(), setYieldController and setJobManager,
 * and nothing anywhere said so. version() is the cheapest possible answer —
 * it is bumped in the same commit as any storage-layout change.
 */
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as `0x${string}`;
const implSlot = await pc.getStorageAt({ address: SF, slot: EIP1967_IMPL });
const impl = implSlot && implSlot !== `0x${"0".repeat(64)}` ? `0x${implSlot.slice(-40)}` : null;
t("address is an upgradeable proxy", !!impl, impl ? `implementation ${impl}` : "no EIP-1967 implementation slot — this is NOT a proxy");

const version = await read("version");
t("implementation reports a version", typeof version === "string" && !!version, String(version ?? "version() missing — ABI predates the deployed contract"));

/*
 * THE YIELD CLAIM, CHECKED RATHER THAN ASSERTED.
 *
 * "Escrowed funds earn" is two separate facts: a controller attached to the
 * escrow, and a VENUE attached to the controller. The first is true on mainnet
 * and the second is not, and only the second decides whether a cent has ever
 * earned anything. Printing both is what stops the README claiming yield while
 * the adapter slot is address(0).
 *
 * The token key is address(0), not the USDC precompile — on Arc USDC is the
 * native asset and the controller books it as native.
 */
const controller = await read("yieldController");
const hasController = !!controller && controller !== "0x0000000000000000000000000000000000000000";
t("yield controller attached to escrow", hasController, String(controller));

if (hasController) {
  const yAbi = [
    { type: "function", name: "yieldAdapter", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
    { type: "function", name: "deployedAssets", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "freelancerShareBP", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "escrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  ] as const;
  const y = async (fn: "yieldAdapter" | "deployedAssets" | "freelancerShareBP" | "escrow", args: any[] = []) => {
    try { return await pc.readContract({ address: controller as `0x${string}`, abi: yAbi, functionName: fn, args: args as any }); } catch { return undefined; }
  };
  const backRef = await y("escrow");
  t("controller points back at this escrow", String(backRef).toLowerCase() === SF.toLowerCase(), String(backRef));

  const NATIVE = "0x0000000000000000000000000000000000000000" as `0x${string}`;
  const adapter = await y("yieldAdapter", [NATIVE]);
  const deployed = await y("deployedAssets", [NATIVE]);
  const share = await y("freelancerShareBP");
  const hasVenue = !!adapter && adapter !== NATIVE;
  console.log(`
  yield controller ${controller}`);
  console.log(`        venue (native)   : ${hasVenue ? adapter : "address(0) — NO VENUE, nothing can earn"}`);
  console.log(`        deployed assets  : ${deployed === undefined ? "?" : formatUnits(deployed as bigint, 6)} USDC`);
  console.log(`        freelancer share : ${share === undefined ? "?" : Number(share) / 100}%`);
  // Deliberately NOT a failure. No venue is the correct, honest state on a chain
  // that has none worth using — the failure would be claiming otherwise.
  console.log(`        ${hasVenue ? "escrows CAN earn" : "escrows cannot earn yet — do not claim yield anywhere in the UI or docs"}`);
}

if (TREASURY) {
  const nat = await pc.getBalance({ address: TREASURY });
  const bal = await pc.readContract({ address: USDC, abi: erc, functionName: "balanceOf", args: [TREASURY] });
  console.log(`\n  treasury ${TREASURY}`);
  console.log(`        native (gas) : ${formatEther(nat)}`);
  console.log(`        USDC         : ${formatUnits(bal as bigint, 6)}`);
  t("treasury can pay gas", nat > 0n);
  t("treasury can fund a $0.20 job", (bal as bigint) >= 202_000n, `needs ~0.202 incl. the 1% platform fee`);
} else {
  // A skipped check reads like a passed one in a wall of PASS lines. The whole
  // point of this script is to be run before money moves, so not knowing
  // whether the treasury can fund a job is a failure, not a footnote.
  t("treasury checks ran", false, "CIRCLE_WALLET_ADDRESS not set — cannot tell if the treasury can pay for anything");
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
