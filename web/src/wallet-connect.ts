// wallet-connect.ts — lets a HUMAN connect their OWN wallet (MetaMask etc.) to fund
// Patron's treasury with one click, instead of copy-pasting an address. This is
// unrelated to Patron's own custody model: Patron's keys stay server-side with
// Circle MPC exactly as before (see IMPLEMENTATION.md) — this only ever signs with
// the VISITOR's own wallet, sending the visitor's own funds, by the visitor's own
// explicit approval in their wallet's UI. Nothing here can move Patron's funds.
import { useCallback, useState } from "react";
import { createWalletClient, custom, formatEther, parseEther } from "viem";

const ARC_TESTNET_CHAIN_ID_HEX = "0x4cef52"; // 5042002
const ARC_TESTNET_PARAMS = {
  chainId: ARC_TESTNET_CHAIN_ID_HEX,
  chainName: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.drpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function getInjectedProvider(): Eip1193Provider | null {
  const anyWindow = window as unknown as { ethereum?: Eip1193Provider };
  return anyWindow.ethereum ?? null;
}

/**
 * Turn whatever a wallet threw into a sentence.
 *
 * This was `err instanceof Error ? err.message : String(err)`, which is wrong
 * for exactly this API: EIP-1193 providers reject with a PLAIN OBJECT —
 * `{ code: 4001, message: "User rejected the request." }` — not an Error. So
 * the instanceof check failed, String() fell through to Object.prototype, and
 * the user got a red box reading "[object Object]" for the single most normal
 * outcome there is: closing the wallet popup.
 *
 * The codes are worth naming individually. "User rejected" is not an error to
 * apologise for, and "request already pending" is solved by looking at the
 * extension you already have open — neither is served by a raw dump.
 */
export function describeWalletError(err: unknown): string {
  if (typeof err === "string") return err;

  const e = err as { code?: number | string; message?: string; data?: { message?: string }; shortMessage?: string };

  switch (e?.code) {
    case 4001:
    case "ACTION_REJECTED":
      return "You cancelled the request in your wallet — nothing was sent.";
    case -32002:
      return "Your wallet already has a pending request. Open the extension and finish or dismiss it, then try again.";
    case 4900:
    case 4901:
      return "Your wallet isn't connected to a network. Unlock it and try again.";
    case -32603:
      return e.data?.message ?? "Your wallet rejected the request internally. Check you're on Arc Testnet with enough balance for gas.";
  }

  // viem wraps provider errors and puts the useful line in shortMessage.
  if (e?.shortMessage) return e.shortMessage;
  if (e?.data?.message) return e.data.message;
  if (e?.message) return e.message;
  if (err instanceof Error) return err.message;

  // Last resort — still never "[object Object]".
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json.slice(0, 200);
  } catch {
    /* circular */
  }
  return "Your wallet returned an error with no details.";
}

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

export function useWalletConnect() {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState("");
  /**
   * What the VISITOR is holding, in their own wallet.
   *
   * We were asking someone to type an amount to send with no indication of what
   * they had — so the only way to discover you couldn't afford it was to be
   * rejected by the chain. On Arc the native currency IS USDC, so this is the
   * same unit as the figure they're about to type.
   */
  const [balance, setBalance] = useState<string | null>(null);

  const readBalance = useCallback(async (who: string) => {
    const provider = getInjectedProvider();
    if (!provider) return;
    try {
      const wei = (await provider.request({ method: "eth_getBalance", params: [who, "latest"] })) as string;
      setBalance(formatEther(BigInt(wei)));
    } catch {
      setBalance(null); // never fatal — it's a convenience, not a gate
    }
  }, []);

  const connect = useCallback(async () => {
    const provider = getInjectedProvider();
    if (!provider) {
      setError("No wallet found — install MetaMask or another browser wallet.");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts[0]) throw new Error("No account returned");

      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_TESTNET_CHAIN_ID_HEX }] });
      } catch (switchErr) {
        // 4902 = chain not added to the wallet yet
        if ((switchErr as { code?: number })?.code === 4902) {
          await provider.request({ method: "wallet_addEthereumChain", params: [ARC_TESTNET_PARAMS] });
        } else {
          throw switchErr;
        }
      }

      setAddress(accounts[0]);
      void readBalance(accounts[0]);
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setConnecting(false);
    }
  }, []);

  const fund = useCallback(
    async (toAddress: string, amountUsdc: string) => {
      const provider = getInjectedProvider();
      if (!provider || !address) {
        setError("Connect your wallet first.");
        return null;
      }
      setFunding(true);
      setError("");
      try {
        const walletClient = createWalletClient({ transport: custom(provider) });
        const hash = await walletClient.sendTransaction({
          account: address as `0x${string}`,
          to: toAddress as `0x${string}`,
          value: parseEther(amountUsdc),
          chain: null,
        });
        void readBalance(address);
        return hash;
      } catch (err) {
        setError(describeWalletError(err));
        return null;
      } finally {
        setFunding(false);
      }
    },
    [address, readBalance],
  );

  return { address, balance, connecting, funding, error, connect, fund, refreshBalance: () => address && readBalance(address) };
}
