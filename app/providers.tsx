import { WalletProvider } from '@/app/context/wallet';
import { AggLayerSDKProvider } from '@/app/context/aggLayerSdk';
import { TokenProvider } from '@/app/context/token';
import { ReactNode } from 'react';

export const Providers = ({ children }: { children: ReactNode }) => {
  return (
    <WalletProvider>
      <AggLayerSDKProvider>
        <TokenProvider>{children}</TokenProvider>
      </AggLayerSDKProvider>
    </WalletProvider>
  );
};
