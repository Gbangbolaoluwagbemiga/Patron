// x402-seller — the counter where quest givers (AI agents, or humans) drop gold.
// Any client hitting POST /api/hire without a valid payment gets 402 Payment
// Required; this wraps Circle's Gateway batching middleware so payment is a
// gasless EIP-3009 authorization, settled sub-cent via Gateway batching.
//
// This is the commission fee that OPENS the order — not the job budget. The job
// budget is a separate amount locked in SecureFlow escrow once the brief is
// generated (see index.ts /api/hire handler). Fee = pay-per-call; escrow = the vault.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createGatewayMiddleware, type PaymentRequest, type PaymentResponse } from "@circle-fin/x402-batching/server";
import { config } from "../config.js";

const ARC_TESTNET_NETWORK = `eip155:${5042002}`;

/**
 * Applies Circle's x402 paywall to a raw Node request/response pair. Returns
 * `true` if the caller paid and the handler should proceed, `false` if the
 * middleware already wrote a 402 (or an error) and the caller must stop.
 */
export function createPatronPaywall(sellerAddress: `0x${string}`, priceUsdc: string) {
  const paywall = createGatewayMiddleware({
    sellerAddress,
    networks: ARC_TESTNET_NETWORK,
    facilitatorUrl: config.gatewayFacilitatorUrl,
  }).require(`$${priceUsdc}`);

  return function applyPaywall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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
  };
}

export const ORDER_FEE_USDC = config.x402OrderFee;
