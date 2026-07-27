import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { config } from "./config.js";

/**
 * One-time setup for the buyer demo's own Circle Programmable Wallet (MPC custody).
 *
 *   npm run wallet:setup
 *
 * Reuses the SAME Circle account (CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET) as
 * daemon/.env — copy those two values across — but provisions a brand-new,
 * dedicated wallet so the buyer has its own on-chain identity, separate from
 * Patron's treasury. Circle holds the key shares; no raw key ever exists here.
 */
async function main() {
  const apiKey = config.circleApiKey;
  const entitySecret = config.circleEntitySecret;
  if (!apiKey || !entitySecret) {
    console.error(
      "✗ Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in buyer-demo/.env first.\n" +
        "  Copy them from daemon/.env — same Circle account, new wallet.",
    );
    process.exit(1);
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  console.log("→ Creating wallet set 'Patron Buyer Demo'…");
  const wsRes: any = await client.createWalletSet({ name: "Patron Buyer Demo" });
  const walletSetId: string | undefined = wsRes?.data?.walletSet?.id;
  if (!walletSetId) throw new Error("no wallet set id returned");

  console.log(`→ Creating an MPC wallet on ${config.circleBlockchain}…`);
  const wRes: any = await client.createWallets({
    walletSetId,
    blockchains: [config.circleBlockchain as never],
    count: 1,
    accountType: "EOA",
  });
  const wallet = wRes?.data?.wallets?.[0];
  if (!wallet?.address) throw new Error("no wallet returned");

  console.log("\n✅ Buyer Agent Wallet created — key shares held by Circle, no raw key here.\n");
  console.log("   wallet id : " + wallet.id);
  console.log("   address   : " + wallet.address);
  console.log("   chain     : " + (wallet.blockchain ?? config.circleBlockchain));
  console.log("\n── Add these to buyer-demo/.env ──");
  console.log(`BUYER_WALLET_ID=${wallet.id}`);
  console.log(`BUYER_WALLET_ADDRESS=${wallet.address}`);
  console.log("\nNext: fund that address with testnet USDC on Arc, then run `npm run demo`.\n");
}

main().catch((e) => {
  console.error("✗ wallet:setup failed:", e?.response?.data ?? e?.message ?? e);
  process.exit(1);
});
