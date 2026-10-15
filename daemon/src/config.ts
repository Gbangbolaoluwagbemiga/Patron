import "dotenv/config";
import { defineChain } from "viem";

/**
 * Arc — Circle's stablecoin-native L1. USDC is the native currency.
 *
 * Every network-specific value is environment-driven, and the DEFAULTS ARE
 * MAINNET. That direction matters: a missing variable should fail toward the
 * network we actually run on, not quietly point a live daemon at testnet and
 * report success against money that isn't real.
 *
 *   mainnet  chainId 5042     rpc.mainnet.arc.io     explorer.arc.io
 *   testnet  chainId 5042002  rpc.testnet.arc.io     explorer.testnet.arc.io
 *
 * `testnet` is derived rather than declared, so it can never disagree with the
 * chain id it sits next to.
 */
export const ARC_MAINNET_ID = 5042;

export const rpcUrl = process.env.ARC_RPC_URL?.trim() || "https://rpc.mainnet.arc.io";
export const chainId = Number(process.env.ARC_CHAIN_ID ?? ARC_MAINNET_ID);
export const explorerUrl = (process.env.ARC_EXPLORER_URL?.trim() || "https://explorer.arc.io").replace(/\/+$/, "");

/**
 * Still exported as `arcTestnet` because ~30 call sites import that name and
 * renaming them buys nothing but churn. It is whichever Arc network the
 * environment points at.
 */
export const arcTestnet = defineChain({
  id: chainId,
  name: chainId === ARC_MAINNET_ID ? "Arc" : "Arc Testnet",
  /*
   * 18, not 6.
   *
   * On Arc the native asset and the ERC-20 at 0x3600... are the SAME money at
   * two scales: the treasury reads 0.701073393020471662 from eth_getBalance
   * (18dp) and 701073 from balanceOf (6dp) in the same instant — a factor of
   * 1e12. Circle's own SDK declares both arc and arcTestnet with decimals: 18,
   * and MAINNET.md says 18.
   *
   * Declaring 6 here made every formatEther gas figure viem renders wrong by
   * 1e12 (a $0.0004 transaction prints as $420,021,000), and would have been
   * live rather than cosmetic the first time anything sent a native `value` —
   * today nothing does, because every transfer takes the ERC-20 path.
   */
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Arc Explorer", url: explorerUrl } },
  testnet: chainId !== ARC_MAINNET_ID,
});

/** One place that builds explorer links, so none of them can be left on testnet. */
export const explorerTx = (txHash: string) => `${explorerUrl}/tx/${txHash}`;
export const explorerAddress = (addr: string) => `${explorerUrl}/address/${addr}`;

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",

  // Groq — temporary stand-in LLM provider while the Anthropic account has no
  // credit balance. Same call shape (structured JSON), swap back by pointing
  // agent/* at the Anthropic client again once billing is sorted.
  groqApiKey: process.env.GROQ_API_KEY?.trim() || "",
  // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16. Anything
  // still defaulting to it fails closed with no served model.
  groqModel: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b",
  groqFallbackModel: process.env.GROQ_FALLBACK_MODEL?.trim() || "openai/gpt-oss-20b",
  /**
   * The score an applicant must reach to be hired.
   *
   * Configurable because it is MODEL-DEPENDENT, which is not obvious and cost a
   * near-outage to learn. Re-scoring 25 historical applications when
   * llama-3.3-70b was decommissioned showed gpt-oss-120b running a mean 10
   * points lower on the same letters — at a fixed bar of 70 that took hiring
   * from 9 of 9 down to 1, while every surface still reported healthy.
   *
   * Any model swap must be re-calibrated against scoring history before it is
   * trusted. The bar is not a product decision; it is a property of the model.
   */
  hireScoreThreshold: Number(process.env.HIRE_SCORE_THRESHOLD ?? 55),

  // SecureFlow — Patron calls this contract, does NOT deploy its own
  /*
   * No default, deliberately.
   *
   * This fell back to 0x6142bf48…ab59 — the old Arc TESTNET contract — which
   * contradicts this file's own stated rule that a missing variable should fail
   * toward the network we actually run on. Unset the variable on a mainnet
   * daemon and it would quietly read and write a testnet deployment, with every
   * escrow id resolving to a different job.
   *
   * Throwing is the only honest default for the address that decides where the
   * money is.
   */
  secureflowAddress: (() => {
    const addr = process.env.SECUREFLOW_CONTRACT_ADDRESS?.trim();
    if (!addr) {
      throw new Error(
        "SECUREFLOW_CONTRACT_ADDRESS is not set. It has no default: guessing it would point this daemon at the wrong network's escrows.",
      );
    }
    return addr as `0x${string}`;
  })(),
  usdcAddress: (process.env.USDC_ADDRESS?.trim() ||
    "0x3600000000000000000000000000000000000000") as `0x${string}`,
  graphUrl: process.env.GRAPH_URL?.trim() || "",

  // Circle Programmable Wallets (MPC) — the Patron Agent Wallet treasury.
  circleApiKey: process.env.CIRCLE_API_KEY?.trim() || "",
  circleEntitySecret: process.env.CIRCLE_ENTITY_SECRET?.trim() || "",
  circleWalletId: process.env.CIRCLE_WALLET_ID?.trim() || "",
  circleWalletAddress: (process.env.CIRCLE_WALLET_ADDRESS?.trim() || "") as `0x${string}` | "",
  circleBlockchain: process.env.CIRCLE_BLOCKCHAIN?.trim() || "ARC",

  /*
   * Circle Gateway (x402 nanopayments).
   *
   * Derived from the chain, not merely defaulted. The old version defaulted to
   * mainnet and let GATEWAY_FACILITATOR_URL override it — and the deployed
   * environment then carried the TESTNET facilitator while the daemon ran on
   * mainnet, which is precisely the confusion the comment here claimed to
   * prevent. An override that can silently point the money at another network
   * is not a convenience.
   *
   * An explicit env var still wins, because testing against a local facilitator
   * has to stay possible — but a value that disagrees with the chain is shouted
   * about rather than used quietly.
   */
  gatewayFacilitatorUrl: (() => {
    const forChain =
      Number(process.env.ARC_CHAIN_ID ?? ARC_MAINNET_ID) === ARC_MAINNET_ID
        ? "https://gateway-api.circle.com"
        : "https://gateway-api-testnet.circle.com";
    const override = process.env.GATEWAY_FACILITATOR_URL?.trim();
    if (override && override !== forChain) {
      console.warn(
        `[config] GATEWAY_FACILITATOR_URL is ${override} but this chain wants ${forChain}. ` +
          `Using the chain's. Unset the variable, or set it to match.`,
      );
      return forChain;
    }
    return override || forChain;
  })(),
  x402OrderFee: process.env.X402_ORDER_FEE?.trim() || "0.05",

  // x402 BUY side — Patron paying a marketplace service (services/portfolio-check)
  // to verify the leading applicant before hiring. Unset = skip verification.
  portfolioCheckUrl: process.env.PORTFOLIO_CHECK_URL?.trim() || "",

  // Application-level spending policy — the second cage. The Developer-Controlled
  // Wallets SDK has no native policy engine, so Patron enforces caps itself before
  // every signed spend (see circle/gateway.ts).
  dailySpendCapUsdc: Number(process.env.DAILY_SPEND_CAP_USDC ?? 50),
  x402BuySpendCapUsdc: Number(process.env.X402_BUY_SPEND_CAP_USDC ?? 5),

  // Hard ceiling on any single commission, enforced before escrow is opened.
  // The budget in a brief is produced by an LLM, and an LLM will happily invent
  // one: a live e2e run asking for a "$1" logo came back with milestones of
  // $50/$25/$25 and tried to lock $100. That attempt only failed because the
  // treasury was too small to cover it — with a funded wallet it would have
  // quietly locked 100x the requested amount.
  maxJobBudgetUsdc: Number(process.env.MAX_JOB_BUDGET_USDC ?? 100),

  // How long a job stays open for applications before the guild master judges.
  //
  // Without a window, scoring fired the moment the FIRST application landed and
  // hired anyone clearing the bar — so the job went to whoever was fastest, not
  // whoever was best, and the "one comparative call ranking applicants against
  // each other" only ever compared a pool of one. A marketplace that rewards
  // refresh speed over skill is not the marketplace we claim to be building.
  //
  // Short by default because a hackathon demo cannot wait an hour; a real
  // deployment would set this far higher, and a client can already ask for
  // longer in their instruction.
  applicationWindowMinutes: Number(process.env.APPLICATION_WINDOW_MINUTES ?? 3),

  // Managed-worker layer. All worker wallets live in one Circle wallet set,
  // separate from the treasury's. Set this after the first signup creates it, so
  // a restart reuses the same set instead of making a new one each boot.
  workerWalletSetId: process.env.WORKER_WALLET_SET_ID?.trim() || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",

  port: Number(process.env.PORT ?? 8787),
};

/** USDC on Arc Testnet has 6 decimals. */
export const USDC_DECIMALS = 6;
