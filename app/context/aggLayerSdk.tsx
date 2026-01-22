'use client';

import type { PropsWithChildren } from 'react';
import React, { createContext, useContext, useMemo } from 'react';
import { AggLayerSDK, SDK_MODES } from '@agglayer/sdk';
import { useAppMode } from '@/app/context/app-mode';
import { AppChain } from '@/app/types/app-mode';

type AggNative = ReturnType<AggLayerSDK['getNative']>;

const AggLayerNativeContext = createContext<AggNative | null>(null);

const toSdkChainConfig = (chain: AppChain, bridgeAddress: string, proofApiUrl: string) => ({
  chainId: chain.id,
  networkId: chain.networkId,
  name: chain.name,
  rpcUrl: chain.rpcUrl,
  nativeCurrency: {
    name: chain.nativeCurrency.name,
    symbol: chain.nativeCurrency.symbol,
    decimals: chain.nativeCurrency.decimals,
  },
  blockExplorer: chain.explorer ? { name: chain.name, url: chain.explorer } : undefined,
  bridgeAddress,
  proofApiUrl,
  isTestnet: chain.isTestnet,
});

export const AggLayerSDKProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const { config, defaultFromChainId } = useAppMode();

  const native = useMemo(() => {
    const sdk = new AggLayerSDK({
      mode: [SDK_MODES.NATIVE],
      native: {
        defaultNetwork: defaultFromChainId,
        chains: config.chains.map((chain: AppChain) =>
          toSdkChainConfig(chain, config.bridgeAddress, config.proofApiUrl),
        ),
      },
    });

    return sdk.getNative();
  }, [config, defaultFromChainId]);

  return <AggLayerNativeContext.Provider value={native}>{children}</AggLayerNativeContext.Provider>;
};

export const useAggNative = (): AggNative => {
  const native = useContext(AggLayerNativeContext);
  if (!native) {
    throw new Error('useAggNative must be used within AggLayerSDKProvider');
  }
  return native;
};
