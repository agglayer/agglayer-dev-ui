import type { ReactNode } from 'react';

import { AppConfigGate } from '@/app/components/appConfigGate';
import { AggkitAggregatorProvider, AggLayerSDKProvider } from '@/app/context/aggLayerSdk';
import { AppModeProvider } from '@/app/context/appMode';
import { PendingBridgesProvider } from '@/app/context/pendingBridges';
import { RefetchProvider } from '@/app/context/refetch';
import { TokenProvider } from '@/app/context/token';
import { WalletProvider } from '@/app/context/wallet';

export const Providers = ({ children }: { children: ReactNode }) => {
  return (
    <AppConfigGate>
      <AppModeProvider>
        <WalletProvider>
          <AggLayerSDKProvider>
            <AggkitAggregatorProvider>
              <RefetchProvider>
                <PendingBridgesProvider>
                  <TokenProvider>{children}</TokenProvider>
                </PendingBridgesProvider>
              </RefetchProvider>
            </AggkitAggregatorProvider>
          </AggLayerSDKProvider>
        </WalletProvider>
      </AppModeProvider>
    </AppConfigGate>
  );
};
