import { ReactNode } from 'react';
import { AggLayerSDKProvider } from '@/app/context/aggLayerSdk';
import { AppModeProvider } from '@/app/context/app-mode';
import { RefetchProvider } from '@/app/context/refetch';
import { TokenProvider } from '@/app/context/token';
import { WalletProvider } from '@/app/context/wallet';

export const Providers = ({ children }: { children: ReactNode }) => {
  return (
    <AppModeProvider>
      <WalletProvider>
        <AggLayerSDKProvider>
          <RefetchProvider>
            <TokenProvider>{children}</TokenProvider>
          </RefetchProvider>
        </AggLayerSDKProvider>
      </WalletProvider>
    </AppModeProvider>
  );
};
