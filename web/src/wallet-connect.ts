// wallet-connect.ts — lets a HUMAN connect their OWN wallet (MetaMask etc.) to fund
// Patron's treasury with one click, instead of copy-pasting an address. This is
// unrelated to Patron's own custody model: Patron's keys stay server-side with
// Circle MPC exactly as before (see IMPLEMENTATION.md) — this only ever signs with
// the VISITOR's own wallet, sending the visitor's own funds, by the visitor's own
// explicit approval in their wallet's UI. Nothing here can move Patron's funds.
import { useCallback, useState } from "react";
import { createWalletClient, custom, parseEther } from "viem";

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

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

export function useWalletConnect() {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [funding, setFunding] = useState(false);
  const [error, setError] = useState("");

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        return hash;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setFunding(false);
      }
    },
    [address],
  );

  return { address, connecting, funding, error, connect, fund };
}
