import { ReactNode } from 'react';
import { AggLayerSDKProvider } from '@/app/context/aggLayerSdk';
import { AppModeProvider } from '@/app/context/app-mode';
import { RefetchProvider } from '@/app/context/refetch';
import { TokenProvider } from '@/app/context/token';
import { E2EWalletProvider, isE2EWalletEnabled } from '@/app/context/e2e-wallet';
import { WalletProvider } from '@/app/context/wallet';

export const Providers = ({ children }: { children: ReactNode }) => {
  const WalletProviderComponent = isE2EWalletEnabled ? E2EWalletProvider : WalletProvider;

  return (
    <AppModeProvider>
      <WalletProviderComponent>
        <AggLayerSDKProvider>
          <RefetchProvider>
            <TokenProvider>{children}</TokenProvider>
          </RefetchProvider>
        </AggLayerSDKProvider>
      </WalletProviderComponent>
    </AppModeProvider>
  );
};
