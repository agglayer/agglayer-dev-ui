'use client';

import type { AppChain } from '@/app/types/appMode';
import type { PropsWithChildren } from 'react';

import { useAppMode } from '@/app/context/appMode';
import React, { createContext, useContext, useMemo } from 'react';

import { AggkitBridgeAggregator, AggLayerSDK, SDK_MODES } from '@agglayer/sdk';

type AggNative = ReturnType<AggLayerSDK['getNative']>;

const AggLayerNativeContext = createContext<AggNative | null>(null);

// NATIVE's `ChainConfig.proofApiUrl` served the old bridge-hub `BridgeUtil`
// claim-proof path. The dev-ui never calls that path (it uses
// `buildClaimAsset(params)` with an externally-fetched proof, now sourced
// from `AggkitBridgeAggregator.getClaimInputs`), so `proofApiUrl` is simply
// omitted here rather than pointed at a real URL.
const toSdkChainConfig = (chain: AppChain, bridgeAddress: string) => ({
  chainId: chain.id,
  networkId: chain.networkId,
  name: chain.name,
  rpcUrl: chain.rpcUrl,
  nativeCurrency: {
    name: chain.nativeCurrency.name,
    symbol: chain.nativeCurrency.symbol,
    decimals: chain.nativeCurrency.decimals
  },
  blockExplorer: chain.explorer ? { name: chain.name, url: chain.explorer } : undefined,
  bridgeAddress,
  isTestnet: chain.isTestnet
});

export const AggLayerSDKProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const { config } = useAppMode();

  const native = useMemo(() => {
    const sdk = new AggLayerSDK({
      mode: [SDK_MODES.NATIVE],
      native: {
        defaultNetwork: config.defaultFromChainId,
        // Registers each enabled mode's chains (incl. devnet's enclave L1/L2)
        // into the SDK's shared chainRegistry singleton — this is also what
        // makes `AggkitBridgeAggregator.getTokenMetadata()`'s native branch
        // (`chainRegistry.getChainByNetworkId`) resolve devnet's L2 (networkId
        // 1) correctly, and devnet's L1 (networkId 0) too: on a networkId
        // collision, ChainRegistry.getChainByNetworkId prefers a
        // consumer-registered chain (this one) over its own pre-registered
        // Ethereum mainnet/Sepolia defaults, regardless of registration order.
        chains: config.chains.map((chain: AppChain) =>
          toSdkChainConfig(chain, config.bridgeAddress)
        )
      }
    });

    return sdk.getNative();
  }, [config]);

  return <AggLayerNativeContext.Provider value={native}>{children}</AggLayerNativeContext.Provider>;
};

export const useAggNative = (): AggNative => {
  const native = useContext(AggLayerNativeContext);
  if (!native) {
    throw new Error('useAggNative must be used within AggLayerSDKProvider');
  }
  return native;
};

const AggkitAggregatorContext = createContext<AggkitBridgeAggregator | null>(null);

// Sibling to AggLayerSDKProvider: fans out to one
// AggkitBridgeClient per configured L2 network (app/services/* consume this
// instead of calling the old bridge-hub REST endpoints directly).
export const AggkitAggregatorProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const { config } = useAppMode();

  const aggregator = useMemo(
    () => new AggkitBridgeAggregator({ networks: config.aggkitBridgeApis }),
    [config]
  );

  return (
    <AggkitAggregatorContext.Provider value={aggregator}>
      {children}
    </AggkitAggregatorContext.Provider>
  );
};

export const useAggkitAggregator = (): AggkitBridgeAggregator => {
  const aggregator = useContext(AggkitAggregatorContext);
  if (!aggregator) {
    throw new Error('useAggkitAggregator must be used within AggkitAggregatorProvider');
  }
  return aggregator;
};
