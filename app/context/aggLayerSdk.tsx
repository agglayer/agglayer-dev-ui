'use client';

import type { PropsWithChildren } from 'react';
import React, { createContext, useContext, useMemo } from 'react';
import { AggLayerSDK, SDK_MODES } from '@agglayer/sdk';
import {
  mainnet,
  sepolia,
  polygon,
  polygonAmoy,
  xLayer,
  polygonZkEvm,
  katana,
  ternoa,
} from 'wagmi/chains';

type AggNative = ReturnType<AggLayerSDK['getNative']>;

const AggLayerNativeContext = createContext<AggNative | null>(null);

const forknetChainId = 8338;

export const AggLayerSDKProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const native = useMemo(() => {
    // Build custom RPC URLs from wagmi chains
    const customRpcUrls: Record<number, string> = {
      [mainnet.id]: mainnet.rpcUrls.default.http[0],
      [sepolia.id]: sepolia.rpcUrls.default.http[0],
      [polygon.id]: polygon.rpcUrls.default.http[0],
      [polygonAmoy.id]: polygonAmoy.rpcUrls.default.http[0],
      [xLayer.id]: xLayer.rpcUrls.default.http[0],
      [polygonZkEvm.id]: polygonZkEvm.rpcUrls.default.http[0],
      [katana.id]: katana.rpcUrls.default.http[0],
      [ternoa.id]: ternoa.rpcUrls.default.http[0],
      [forknetChainId]: 'https://rpc-forknet.t.conduit.xyz',
    };

    const sdk = new AggLayerSDK({
      mode: [SDK_MODES.NATIVE],
      native: {
        defaultNetwork: mainnet.id,
        customRpcUrls,
        chains: [
          {
            chainId: forknetChainId,
            networkId: forknetChainId,
            name: 'Forknet',
            rpcUrl: 'https://rpc-forknet.t.conduit.xyz',
            nativeCurrency: {
              name: 'Ether',
              symbol: 'ETH',
              decimals: 18,
            },
            blockExplorer: {
              name: 'Forkscan',
              url: 'https://forkscan.org/',
            },
            isTestnet: true,
          },
        ],
      },
    });

    return sdk.getNative();
  }, []);

  return <AggLayerNativeContext.Provider value={native}>{children}</AggLayerNativeContext.Provider>;
};

export const useAggNative = (): AggNative => {
  const native = useContext(AggLayerNativeContext);
  if (!native) {
    throw new Error('useAggNative must be used within AggLayerSDKProvider');
  }
  return native;
};
