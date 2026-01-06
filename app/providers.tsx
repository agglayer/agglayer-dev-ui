import { WalletProvider } from "@/app/context/wallet";
import { ReactNode } from "react";

export const Providers = ({ children }: { children: ReactNode }) => {
  return (
    <WalletProvider>{children}</WalletProvider>
  )
}
