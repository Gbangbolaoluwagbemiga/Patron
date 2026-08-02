// index.ts — a standalone x402-paywalled marketplace service: portfolio/reputation
// lookup on a wallet address. This is what Patron pays over x402 mid-decision to
// verify the leading applicant's track record before hiring — the BUY side of the
// x402 protocol (Patron previously only ever demonstrated the SELL side, receiving
// payment at /api/hire). Deliberately its own tiny service with its own wallet, not
// a function inside the daemon, so paying it is a genuine machine-to-machine
// transaction between two independent parties, not Patron paying itself.
//
//   GET /verify?address=0x...   x402-gated — returns a deterministic mock score
//   GET /healthz                unguarded

import http from "node:http";
import { createGatewayMiddleware, type PaymentRequest, type PaymentResponse } from "@circle-fin/x402-batching/server";
import { keccak256, toBytes } from "viem";
import { config } from "./config.js";
import { createServiceSigner } from "./circleSigner.js";

const ARC_TESTNET_NETWORK = `eip155:${config.circleBlockchain === "ARC-TESTNET" ? 5042002 : 5042002}`;

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Deterministic mock "portfolio" — same address always yields the same score,
 * so a demo run is reproducible, but it's clearly not a real reputation oracle. */
function mockPortfolio(address: string) {
  const hash = keccak256(toBytes(address.toLowerCase()));
  const n = parseInt(hash.slice(2, 10), 16);
  const score = 40 + (n % 61); // 40-100
  const completedJobs = n % 23;
  const disputes = score < 60 ? (n % 3) : 0;
  return {
    address,
    reputationScore: score,
    completedJobs,
    disputes,
    verified: score >= 60 && disputes === 0,
    summary:
      score >= 80
        ? "Strong track record, no disputes."
        : score >= 60
          ? "Decent history, worth hiring."
          : "Thin or inconsistent history — proceed with caution.",
  };
}

let signerAddress: `0x${string}` | null = null;
function getSellerAddress(): `0x${string}` {
  if (!signerAddress) signerAddress = createServiceSigner().address;
  return signerAddress;
}

/** Recreated per-request — matches the proven pattern in daemon's x402-seller.ts. */
function applyPaywall(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const paywall = createGatewayMiddleware({
    sellerAddress: getSellerAddress(),
    networks: ARC_TESTNET_NETWORK,
    facilitatorUrl: config.gatewayFacilitatorUrl,
  }).require(`$${config.fee}`);

  const preq = req as unknown as PaymentRequest;
  const pres = res as unknown as PaymentResponse;
  pres.status = (code: number) => {
    res.statusCode = code;
    return pres;
  };
  pres.json = (data: unknown) => {
    if (!res.headersSent) res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  };
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    res.on("finish", () => done(false));
    void Promise.resolve(paywall(preq, pres, (err?: unknown) => done(!err)));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment, Payment-Signature");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true, seller: getSellerAddress() });
  }

  if (req.method === "GET" && url.pathname === "/verify") {
    try {
      const address = url.searchParams.get("address");
      if (!address) return json(res, 400, { error: "?address=0x... is required" });

      const proceed = await applyPaywall(req, res);
      if (!proceed) return; // paywall already wrote 402 or an error

      json(res, 200, mockPortfolio(address));
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(config.port, () => {
  console.log(`\n  🔍 PortfolioCheck service listening on http://localhost:${config.port}`);
  console.log(`     GET /verify?address=0x...   (x402-gated, $${config.fee})\n`);
});
