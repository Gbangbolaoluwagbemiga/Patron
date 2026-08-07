// wallet-context.tsx — ONE wallet connection, shared by every component.
//
// This exists because of a real bug. Treasury and PostQuest each called
// useWalletConnect() directly, and a hook owns its own state — so those were
// two independent connections that knew nothing about each other. Connecting in
// the treasury card left PostQuest still holding address = null, which meant it
// sent no signature, fell through to the anonymous path, and commissioned work
// out of the shared pot instead of the depositor's own balance. The cap looked
// like it was working and was simply never consulted.
//
// A connection is a property of the SESSION, not of a card, so it lives here.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { useWalletConnect } from "./wallet-connect";

/** A depositor's position in the pooled treasury. */
export interface TreasuryAccount {
  address: string;
  deposited: string;
  withdrawn: string;
  spent: string;
  claim: string;
  withdrawable: string;
  treasuryOnHand: string;
}

type WalletContextValue = ReturnType<typeof useWalletConnect> & {
  /** Null until a wallet is connected and its position has loaded. */
  account: TreasuryAccount | null;
  refreshAccount: () => Promise<void>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useWalletConnect();
  const [account, setAccount] = useState<TreasuryAccount | null>(null);

  async function refreshAccount() {
    if (!wallet.address) {
      setAccount(null);
      return;
    }
    try {
      setAccount(await api<TreasuryAccount>(`/api/treasury/account?address=${wallet.address}`));
    } catch {
      /* a missing position must not break funding or posting */
    }
  }

  // Reload whenever the connected address changes, and keep it fresh — a
  // commission or a payout moves these numbers without this tab doing anything.
  useEffect(() => {
    void refreshAccount();
    if (!wallet.address) return;
    const t = window.setInterval(() => void refreshAccount(), 20_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  return <WalletContext.Provider value={{ ...wallet, account, refreshAccount }}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
