import { createContext, useContext, type ReactNode } from "react";
import { useDaemonFeed, useWallet } from "./api";

type DaemonContextValue = ReturnType<typeof useDaemonFeed> & {
  wallet: ReturnType<typeof useWallet>["wallet"];
  refreshWallet: ReturnType<typeof useWallet>["refreshWallet"];
};

const DaemonContext = createContext<DaemonContextValue | null>(null);

export function DaemonProvider({ children }: { children: ReactNode }) {
  const feed = useDaemonFeed();
  const { wallet, refreshWallet } = useWallet();
  return <DaemonContext.Provider value={{ ...feed, wallet, refreshWallet }}>{children}</DaemonContext.Provider>;
}

export function useDaemon() {
  const ctx = useContext(DaemonContext);
  if (!ctx) throw new Error("useDaemon must be used inside <DaemonProvider>");
  return ctx;
}
