# Patron → Arc mainnet

Verified against the live chain and Circle's own docs on 17 Sep 2026.

| | Mainnet | Testnet (old) |
|---|---|---|
| Chain ID | **5042** | 5042002 |
| RPC | **https://rpc.mainnet.arc.io** | https://rpc.testnet.arc.io |
| Explorer | **https://explorer.arc.io** | https://explorer.testnet.arc.io |
| USDC (ERC-20 view, 6 dp) | `0x3600000000000000000000000000000000000000` | same |
| Circle blockchain id | **`ARC`** | `ARC-TESTNET` |
| Gateway facilitator | **https://gateway-api.circle.com** | https://gateway-api-testnet.circle.com |

Native gas is USDC with 18 decimals; the ERC-20 interface at `0x3600…` shows the
same balance with 6. Both are the same money.

Confirmed supported on Arc mainnet: Circle Wallets (`ARC`), Circle Gateway
(domain 26) and nanopayments, and Goldsky subgraphs.

## Code is already mainnet-ready

Every network value is environment-driven and **the defaults are now mainnet**.
A missing variable fails toward the network we actually run on instead of
quietly pointing a live daemon at testnet and reporting success against money
that is not real.

- `daemon/src/config.ts` — `chainId`, `rpcUrl`, `explorerUrl`, plus `explorerTx()`
  and `explorerAddress()` helpers. `testnet` is *derived* from the chain id, so
  it cannot disagree with it.
- Every hardcoded `testnet.arcscan.app` link (7 of them, across the daemon,
  Telegram messages and the web app) now routes through those helpers.
- `x402-seller` and `portfolio-check` build their `eip155:` network id from the
  configured chain. The service had `5042002` on *both* branches of a ternary.
- Web app reads `VITE_ARC_CHAIN_ID`, `VITE_ARC_RPC_URL`, `VITE_ARC_EXPLORER_URL`.

## Runbook

### ✅ DONE — SecureFlow is live on Arc mainnet

    contract   0xa60b14a62c871D5E4E7B9AeDb974FAAF688604F5
    deploy     block 21409627   tx 0x4ca55a8a…   0.0961 USDC
    whitelist  block 21409925   tx 0x4d86dda9…   0.0010 USDC
    owner / fee collector       0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41
    platform fee                100 bp (1%)
    USDC                        whitelisted — jobs can be posted

Verified 5/5 by `daemon/scripts/verify-mainnet.ts`. Total cost $0.097
against a $0.247 estimate.

### 1 — Deploy SecureFlow (done; kept for reproducibility)

```sh
cd Secureflow/SecureFlow-scaffold/contracts/solidity
set -a; source .env; set +a
forge script script/Deploy.s.sol --rpc-url arc --broadcast
```

Simulated clean on chain 5042: **6,098,209 gas ≈ 0.244 USDC**.
Deployer `0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41`, nonce 0, holds 1.6164 USDC.
Predicted address `0x7e7b5dbaE3aDb3D94a27DCfB383bDB98667145E6` (nonce-derived —
only valid if this is the wallet's first mainnet transaction).

The script sets **fee collector = deployer** and **platform fee = 2.5%**. Real
fees now flow to your own wallet.

### 2 — Whitelist USDC on the new contract

```sh
SECUREFLOW_ADDRESS=<address from step 1> \
forge script script/WhitelistUSDC.s.sol --rpc-url arc --broadcast
```

(The script used to hardcode the testnet address. It now reads this variable.)

### 3 — Subgraph

Deploy a new Goldsky subgraph against the mainnet contract and note its query
URL. The poller reads applications from it; without this, nothing is indexed.

### 4 — Circle mainnet

- Create the treasury wallet on blockchain **`ARC`**, in a mainnet wallet set.
- Register the entity secret **against the live key** — entity-secret
  registration is per-key, so the testnet registration does not carry over.
- `LIVE_API_KEY` in `daemon/.env` is stored **without its `LIVE_API_KEY:` prefix**
  (65 chars, not 78). Circle's SDK wants the whole string, so set
  `CIRCLE_API_KEY=LIVE_API_KEY:<the 65 chars>`.
- Fund the treasury with USDC on Arc.

### 5 — Environment (daemon, local and Railway)

```
ARC_CHAIN_ID=5042
ARC_RPC_URL=https://rpc.mainnet.arc.io
ARC_EXPLORER_URL=https://explorer.arc.io
SECUREFLOW_CONTRACT_ADDRESS=<step 1>
USDC_ADDRESS=0x3600000000000000000000000000000000000000
GRAPH_URL=<step 3>
CIRCLE_API_KEY=LIVE_API_KEY:<live key>
CIRCLE_ENTITY_SECRET=<registered against the live key>
CIRCLE_WALLET_ID=<mainnet treasury>
CIRCLE_WALLET_ADDRESS=<mainnet treasury>
CIRCLE_BLOCKCHAIN=ARC
WORKER_WALLET_SET_ID=<mainnet wallet set>
GATEWAY_FACILITATOR_URL=https://gateway-api.circle.com
```

Web (Vercel): `VITE_ARC_CHAIN_ID=5042`, `VITE_ARC_RPC_URL=https://rpc.mainnet.arc.io`,
`VITE_ARC_EXPLORER_URL=https://explorer.arc.io`.

Keep the testnet values somewhere. They are the only way back.

### 6 — Before any real job

```sh
cd daemon && npx tsx scripts/e2e-agent.ts
curl -s https://patron-daemon-production.up.railway.app/healthz
```

`/healthz` reports the live model, fallback and hire bar. Then run **one $1 job**
end to end before anything larger.

## Known consequences of the switch

- **The Telegram bot moves with the daemon.** One bot token can only be polled by
  one daemon, so the testnet demo goes quiet and existing freelancers' testnet
  wallets stop mattering. Their handles and history stay in SQLite.
- **Existing testnet escrows are left behind**, including the locked ones whose
  emergency windows opened in September. Reclaiming those needs a daemon pointed
  at testnet, so do it before switching, or accept losing testnet funds.
- **Money is real now.** Keep `DAILY_SPEND_CAP_USDC` and job budgets small
  ($1–5) until a full loop has run on mainnet.
