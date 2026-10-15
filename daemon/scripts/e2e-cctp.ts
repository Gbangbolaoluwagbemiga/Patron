/**
 * CCTP v2 end-to-end on Arc mainnet. SPENDS REAL USDC.
 *
 *   CCTP_AMOUNT=0.10 CCTP_DEST=base npx tsx scripts/e2e-cctp.ts
 *
 * Proves the three things that can each silently not work:
 *   1. the contracts are real and wired (reads)
 *   2. depositForBurn actually burns (a real transaction)
 *   3. Circle attests to OUR burn (their API, polled until it signs)
 *
 * It deliberately does NOT mint on the destination: that needs gas on the
 * destination chain, which this treasury does not hold. The test says so rather
 * than pretending the money arrived.
 */
const { config, chainId } = await import("../src/config.js");
const cctp = await import("../src/web3/cctp.js");
const { createCircleSigner } = await import("../src/circle/circleSigner.js");
const secureflow = await import("../src/web3/secureflow.js");

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

const DEST = (process.env.CCTP_DEST ?? "base").toLowerCase();
const AMOUNT = process.env.CCTP_AMOUNT ?? "0.10";

console.log(`chain ${chainId}  dest ${DEST}  amount $${AMOUNT}\n`);
t("running on Arc mainnet", chainId === 5042, `chainId ${chainId}`);
if (chainId !== 5042) process.exit(1);

console.log("── contracts ──");
const client = secureflow.client();
for (const [name, addr] of [["TokenMessengerV2", cctp.TOKEN_MESSENGER], ["MessageTransmitterV2", cctp.MESSAGE_TRANSMITTER]] as const) {
  const code = await client.getCode({ address: addr });
  t(`${name} deployed`, !!code && code !== "0x", addr);
}
const localDomain = await client.readContract({
  address: cctp.MESSAGE_TRANSMITTER,
  abi: [{ type: "function", name: "localDomain", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] }],
  functionName: "localDomain",
});
t("local domain is Arc (26)", Number(localDomain) === cctp.ARC_DOMAIN, String(localDomain));

console.log("\n── fee quote ──");
const domain = cctp.DOMAINS[DEST]!;
const quotes = await cctp.quoteFees(domain);
t("Circle quotes this route", quotes.length > 0, quotes.map((q) => `finality ${q.finalityThreshold}: ${q.minimumFeeBps}bps`).join("  "));

console.log("\n── balance ──");
const signer = createCircleSigner();
const before = await client.getBalance({ address: signer.address });
console.log(`  treasury ${signer.address}: ${Number(before) / 1e18} USDC`);
t("enough to burn", Number(before) / 1e18 > Number(AMOUNT), `need > ${AMOUNT}`);
if (Number(before) / 1e18 <= Number(AMOUNT)) { console.log("\nstopping — fund the treasury first"); process.exit(1); }

console.log("\n── burn ──");
const burn = await cctp.burnForContractor({
  recipient: signer.address as `0x${string}`, // paying ourselves on the far side
  amountUsdc: AMOUNT,
  destination: DEST,
  as: signer,
});
t("depositForBurn succeeded", true, burn.explorerUrl);
console.log(`  burned ${Number(burn.amountUnits) / 1e6} USDC, maxFee ${Number(burn.maxFeeUnits) / 1e6}, finality ${burn.finalityThreshold}`);

const after = await client.getBalance({ address: signer.address });
const moved = (Number(before) - Number(after)) / 1e18;
t("balance actually decreased", after < before, `-${moved.toFixed(6)} USDC (burn + gas)`);

console.log("\n── Circle attestation ──");
let att = await cctp.attestationFor(burn.txHash);
const started = Date.now();
while (!cctp.isAttested(att) && Date.now() - started < 600_000) {
  process.stdout.write(`  ${att.status} … ${Math.round((Date.now() - started) / 1000)}s\r`);
  await new Promise((r) => setTimeout(r, 10_000));
  att = await cctp.attestationFor(burn.txHash);
}
console.log(" ".repeat(60) + "\r");
t("Circle attested the burn", cctp.isAttested(att), `status=${att.status} after ${Math.round((Date.now() - started) / 1000)}s`);

if (cctp.isAttested(att)) {
  const mint = cctp.mintCalldata(att);
  console.log(`  message    : ${att.message?.slice(0, 42)}… (${att.message?.length} chars)`);
  console.log(`  attestation: ${att.attestation!.slice(0, 42)}… (${att.attestation!.length} chars)`);
  console.log(`  nonce      : ${att.eventNonce ?? "?"}`);
  t("receiveMessage calldata is constructible", !!mint, mint ? `${mint.data.length} chars` : "");
  console.log(`\n  To complete: call receiveMessage on MessageTransmitterV2 on ${DEST} with the above.`);
  console.log(`  NOT done here — that needs gas on ${DEST}, which this treasury does not hold.`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
