/**
 * Can this Circle key + entity secret actually SIGN for the configured wallet?
 *
 *   npx tsx scripts/verify-circle.ts
 *
 * Authenticating proves the API key. It does NOT prove the entity secret, and a
 * wrong entity secret fails only at the moment of signing — which, in this
 * daemon, is the moment it tries to lock a client's money in escrow. So this
 * asks for a signature and nothing else: no transaction, no chain write, no
 * money. The only question is whether this process could move funds if asked.
 */
const { config } = await import("../src/config.js");
const { createCircleSigner, circleCustodyReady } = await import("../src/circle/circleSigner.js");

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

console.log(`  blockchain : ${config.circleBlockchain}`);
console.log(`  wallet     : ${config.circleWalletAddress}`);
console.log(`  contract   : ${config.secureflowAddress}`);
console.log(`  chain id   : ${process.env.ARC_CHAIN_ID ?? "(default)"}\n`);

t("circle custody configured", circleCustodyReady());

const signer = createCircleSigner();
t("signer address matches configured wallet",
  signer.address.toLowerCase() === config.circleWalletAddress.toLowerCase(),
  `${signer.address}`);

/*
 * signTypedData, not signMessage.
 *
 * Circle's EIP-1193 provider does not expose personal_sign, and this is the call
 * the daemon actually makes — it is how x402 payment authorizations are signed.
 * Testing a method production never calls would prove nothing about production.
 */
try {
  const sig = await signer.signTypedData({
    // Mirrors the Gateway burn-intent domain exactly: name + version only.
    // Adding chainId here gets "Invalid parameters" back from Circle's provider.
    domain: { name: "GatewayWallet", version: "1" },
    types: { Check: [{ name: "note", type: "string" }] },
    primaryType: "Check",
    message: { note: "entity-secret preflight" },
  });
  t("entity secret can produce a signature", typeof sig === "string" && sig.startsWith("0x") && sig.length > 100,
    `${sig.slice(0, 18)}… (${sig.length} chars)`);
} catch (e) {
  t("entity secret can produce a signature", false, (String((e as Error).message).split("\n")[0] ?? "").slice(0, 140));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
