import { ReactNode } from 'react';
import { AggLayerSDKProvider } from '@/app/context/aggLayerSdk';
import { AppModeProvider } from '@/app/context/app-mode';
import { RefetchProvider } from '@/app/context/refetch';
import { TokenProvider } from '@/app/context/token';
import { E2EAppModeProvider } from '@/app/context/e2e-app-mode';
import { E2EWalletProvider } from '@/app/context/e2e-wallet';
import { WalletProvider } from '@/app/context/wallet';
import { IS_E2E_ENABLED } from '@/app/constants/e2e';

export const Providers = ({ children }: { children: ReactNode }) => {
  const WalletProviderComponent = IS_E2E_ENABLED ? E2EWalletProvider : WalletProvider;
  const AppModeProviderComponent = IS_E2E_ENABLED ? E2EAppModeProvider : AppModeProvider;

  return (
    <AppModeProviderComponent>
      <WalletProviderComponent>
        <AggLayerSDKProvider>
          <RefetchProvider>
            <TokenProvider>{children}</TokenProvider>
          </RefetchProvider>
        </AggLayerSDKProvider>
      </WalletProviderComponent>
    </AppModeProviderComponent>
  );
};
