// wallet-connect.ts — lets a HUMAN connect their OWN wallet (MetaMask etc.) to fund
// Patron's treasury with one click, instead of copy-pasting an address. This is
// unrelated to Patron's own custody model: Patron's keys stay server-side with
// Circle MPC exactly as before (see IMPLEMENTATION.md) — this only ever signs with
// the VISITOR's own wallet, sending the visitor's own funds, by the visitor's own
// explicit approval in their wallet's UI. Nothing here can move Patron's funds.
import { useCallback, useRef, useState } from "react";
import { createWalletClient, custom, formatEther, parseEther } from "viem";

/** Chain the browser is asked to add/switch to. Env-driven so mainnet and testnet cannot diverge from the daemon. */
const ARC_CHAIN_ID = Number(import.meta.env.VITE_ARC_CHAIN_ID ?? 5042);
const ARC_TESTNET_CHAIN_ID_HEX = `0x${ARC_CHAIN_ID.toString(16)}`;
const ARC_TESTNET_PARAMS = {
  chainId: ARC_TESTNET_CHAIN_ID_HEX,
  chainName: ARC_CHAIN_ID === 5042 ? "Arc" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: [import.meta.env.VITE_ARC_RPC_URL ?? "https://rpc.mainnet.arc.io"],
  blockExplorerUrls: [import.meta.env.VITE_ARC_EXPLORER_URL ?? "https://explorer.arc.io"],
};

/**
 * EIP-6963 — ask which wallets are here instead of taking whichever one won.
 *
 * window.ethereum is a single slot that every installed wallet races to claim,
 * and the winner is not stable between page loads. This machine has four
 * (Rabby, Core, MetaMask, Phantom) and Rabby sets isMetaMask = true for
 * compatibility, so the slot cannot even be identified reliably once claimed.
 *
 * The concrete cost: a connection request got stuck in MetaMask, which this
 * user cannot open any more, and every later click was rejected with -32002 by
 * a wallet they do not use and cannot clear. No amount of retrying fixes that.
 * The only way out is to choose the wallet, which is what 6963 exists for.
 */
export interface DiscoveredWallet {
  rdns: string;
  name: string;
  icon: string;
  provider: Eip1193Provider;
}

const discovered = new Map<string, DiscoveredWallet>();

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { info?: { rdns?: string; name?: string; icon?: string }; provider?: Eip1193Provider }
      | undefined;
    if (!detail?.info?.rdns || !detail.provider) return;
    discovered.set(detail.info.rdns, {
      rdns: detail.info.rdns,
      name: detail.info.name ?? detail.info.rdns,
      icon: detail.info.icon ?? "",
      provider: detail.provider,
    });
  });
  // Wallets announce on request; they also announce on load, so ask repeatedly
  // over the first moment in case this module ran before they were ready.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  setTimeout(() => window.dispatchEvent(new Event("eip6963:requestProvider")), 300);
  setTimeout(() => window.dispatchEvent(new Event("eip6963:requestProvider")), 1200);
}

/** Every wallet that announced itself, deduplicated by rdns. */
export function listWallets(): DiscoveredWallet[] {
  return [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function getInjectedProvider(): Eip1193Provider | null {
  const anyWindow = window as unknown as { ethereum?: Eip1193Provider };
  return anyWindow.ethereum ?? null;
}

/** The chosen wallet if there is one, otherwise whatever claimed window.ethereum. */
function providerFor(rdns: string | null): Eip1193Provider | null {
  return (rdns ? discovered.get(rdns)?.provider : null) ?? getInjectedProvider();
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
    case "TIMEOUT":
      return e.message ?? "Your wallet didn't respond. Open the extension and look for a pending request.";
    case 4001:
    case "ACTION_REJECTED":
      return "You cancelled the request in your wallet — nothing was sent.";
    case -32002:
      return (
        `${walletName()} already has a connection request waiting from an earlier click. ` +
        `Open the extension, approve or dismiss it, and then try again — nothing here will work until that one is cleared.`
      );
    case 4900:
    case 4901:
      return "Your wallet isn't connected to a network. Unlock it and try again.";
    case -32603:
      return e.data?.message ?? "Your wallet rejected the request internally. Check you're on the Arc network with enough balance for gas.";
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

/**
 * Which wallet window.ethereum actually resolved to.
 *
 * Worth naming, because several can be installed at once — this machine
 * announced Rabby, Core, MetaMask and Phantom over EIP-6963 — and only ONE of
 * them wins the window.ethereum slot. "Open your wallet" is unhelpful advice
 * when you have four; "open Rabby" is the whole answer.
 */
export function walletName(): string {
  const p = getInjectedProvider() as (Eip1193Provider & Record<string, boolean>) | null;
  if (!p) return "Your wallet";
  if (p.isRabby) return "Rabby";
  if (p.isMetaMask) return "MetaMask";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  if (p.isBraveWallet) return "Brave Wallet";
  if (p.isPhantom) return "Phantom";
  return "Your wallet";
}

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

export function useWalletConnect() {
  const [address, setAddress] = useState<string | null>(null);
  /**
   * Which wallet the person actually picked, so later signing uses the same one.
   *
   * Mirrored into a ref because fund/signMessage/readBalance are memoised on
   * [address], and a callback that closed over the old choice would sign with
   * a different wallet than the one that connected — which is exactly the
   * confusion this whole change exists to end.
   */
  const [activeRdns, setActiveRdns] = useState<string | null>(null);
  const activeRdnsRef = useRef<string | null>(null);
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
    const provider = providerFor(activeRdnsRef.current);
    if (!provider) return;
    try {
      const wei = (await provider.request({ method: "eth_getBalance", params: [who, "latest"] })) as string;
      setBalance(formatEther(BigInt(wei)));
    } catch {
      setBalance(null); // never fatal — it's a convenience, not a gate
    }
  }, []);

  const connect = useCallback(async (rdns?: string) => {
    // An explicitly chosen wallet always wins over whatever claimed the slot.
    const chosen = rdns ? discovered.get(rdns)?.provider ?? null : null;
    const provider = chosen ?? getInjectedProvider();
    if (!provider) {
      setError("No wallet found — install MetaMask or another browser wallet.");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      /*
       * A WALLET THAT NEVER ANSWERS MUST NOT LOCK THE BUTTON FOREVER.
       *
       * eth_requestAccounts does not resolve or reject while the extension is
       * sitting on an unanswered prompt — and if that popup was blocked,
       * dismissed by the OS, or opened behind the window, nothing ever settles.
       * The button is disabled while `connecting` is true, so the one action
       * that would surface the real cause (clicking again, and getting -32002
       * "request already pending", which this file already explains properly)
       * was the one action the UI prevented. The spinner was the trap.
       *
       * So the request races a timeout. Losing the race is not an error about
       * the wallet being broken — it is almost always a prompt waiting
       * somewhere the person has not looked, and it says so.
       */
      const accounts = (await Promise.race([
        provider.request({ method: "eth_requestAccounts" }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject({
                code: "TIMEOUT",
                message:
                  "Your wallet hasn't responded. Open the extension — there is probably a connection request waiting for you — then try again.",
              }),
            30_000,
          ),
        ),
      ])) as string[];
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

      if (rdns) { setActiveRdns(rdns); activeRdnsRef.current = rdns; }
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
      const provider = providerFor(activeRdnsRef.current);
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

  /**
   * Sign the sentence that authorises a withdrawal.
   *
   * The treasury is Patron's own wallet, so "pay this address" cannot be taken
   * on trust — without a signature anyone could withdraw anyone else's deposit
   * by typing their address. personal_sign is the cheapest proof that the
   * caller actually holds the key to the address they're claiming.
   */
  const signMessage = useCallback(
    async (message: string): Promise<string | null> => {
      const provider = providerFor(activeRdnsRef.current);
      if (!provider || !address) {
        setError("Connect your wallet first.");
        return null;
      }
      setError("");
      try {
        return (await provider.request({ method: "personal_sign", params: [message, address] })) as string;
      } catch (err) {
        setError(describeWalletError(err));
        return null;
      }
    },
    [address],
  );

  return {
    wallets: listWallets(),
    activeRdns,
    address,
    balance,
    connecting,
    funding,
    error,
    connect,
    fund,
    signMessage,
    setError,
    refreshBalance: () => address && readBalance(address),
  };
}
