import { ReactNode } from 'react';
import { AggLayerSDKProvider } from '@/app/context/aggLayerSdk';
import { AppModeProvider } from '@/app/context/appMode';
import { RefetchProvider } from '@/app/context/refetch';
import { TokenProvider } from '@/app/context/token';
import { E2EAppModeProvider } from '@/app/context/e2eAppMode';
import { E2EWalletProvider } from '@/app/context/e2eWallet';
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
