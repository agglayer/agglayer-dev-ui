import { WalletProvider } from '@/app/context/wallet';
import { AggLayerSDKProvider } from '@/app/context/aggLayerSdk';
import { ReactNode } from 'react';

export const Providers = ({ children }: { children: ReactNode }) => {
  return (
    <WalletProvider>
      <AggLayerSDKProvider>{children}</AggLayerSDKProvider>
    </WalletProvider>
  );
};
