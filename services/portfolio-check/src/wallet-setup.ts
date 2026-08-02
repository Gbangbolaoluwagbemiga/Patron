import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { config } from "./config.js";

/**
 * One-time setup for this service's own Circle Programmable Wallet.
 *
 *   npm run wallet:setup
 *
 * Reuses the SAME Circle account as daemon/.env (copy CIRCLE_API_KEY +
 * CIRCLE_ENTITY_SECRET across) but a brand-new wallet — this service needs its
 * own on-chain identity since it's the counterparty Patron pays, not Patron
 * itself.
 */
async function main() {
  const apiKey = config.circleApiKey;
  const entitySecret = config.circleEntitySecret;
  if (!apiKey || !entitySecret) {
    console.error("✗ Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in services/portfolio-check/.env first.");
    process.exit(1);
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  console.log("→ Creating wallet set 'PortfolioCheck Service'…");
  const wsRes: any = await client.createWalletSet({ name: "PortfolioCheck Service" });
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

  console.log("\n✅ PortfolioCheck wallet created.\n");
  console.log("   wallet id : " + wallet.id);
  console.log("   address   : " + wallet.address);
  console.log("\n── Add these to services/portfolio-check/.env ──");
  console.log(`SERVICE_WALLET_ID=${wallet.id}`);
  console.log(`SERVICE_WALLET_ADDRESS=${wallet.address}`);
  console.log("\nNo funding needed — this wallet only ever RECEIVES x402 payments.\n");
}

main().catch((e) => {
  console.error("✗ wallet:setup failed:", e?.response?.data ?? e?.message ?? e);
  process.exit(1);
});
