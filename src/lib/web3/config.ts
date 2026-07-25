// Arc Testnet — same chain SecureFlow is deployed on
export const ARC_TESTNET = {
  chainId: 5042002,
  name: "Arc Testnet",
  rpcUrl: import.meta.env.VITE_ARC_RPC_URL ?? "https://rpc.drpc.testnet.arc.network",
  blockExplorer: "https://testnet.arcscan.app",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
} as const;

// Patron does NOT deploy its own contract — it calls SecureFlow directly
export const CONTRACTS = {
  SECUREFLOW_ESCROW: (import.meta.env.VITE_SECUREFLOW_CONTRACT_ADDRESS ?? "0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59").trim() as `0x${string}`,
  USDC: (import.meta.env.VITE_USDC_TOKEN_CONTRACT ?? "0x3600000000000000000000000000000000000000").trim() as `0x${string}`,
} as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
