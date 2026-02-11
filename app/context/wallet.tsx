'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  useChainId,
  useChains,
  useSwitchChain,
  WagmiProvider,
} from 'wagmi';
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useDisconnect as useAppKitDisconnect,
  useWalletInfo,
} from '@reown/appkit/react';
import type { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { QueryClientProvider } from '@tanstack/react-query';
import { ALL_WAGMI_CHAINS, customRpcUrls, DEFAULT_WAGMI_CHAIN, EXTERNAL_LINKS } from '@/app/config';
import { IS_E2E_ENABLED } from '@/app/constants/e2e';
import { e2eWalletAddress } from '@/app/context/e2eAccount';
import { projectId, queryClient, wagmiSetup } from '@/app/context/wagmiConfig';
import { WalletContext } from '@/app/context/walletContext';
import type { WalletContextValue } from '@/app/context/walletContext';

const urlOrUndefined = (value: string): string | undefined => (value.trim() === '' ? undefined : value);
let isAppKitInitialized = false;

// walletIds - https://docs.reown.com/cloud/wallets/wallet-list
const walletIds = {
  METAMASK: 'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
  COINBASE: 'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa',
  RABBY: '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1',
};

const initializeAppKit = (wagmiAdapter: WagmiAdapter): void => {
  if (isAppKitInitialized) return;

  createAppKit({
    adapters: [wagmiAdapter],
    projectId,
    networks: [...ALL_WAGMI_CHAINS],
    defaultNetwork: DEFAULT_WAGMI_CHAIN,
    customRpcUrls,
    metadata: {
      name: 'agglayer-dev-ui',
      description: 'Agglayer Dev UI',
      url: 'https://dev-ui.agglayer.dev/',
      icons: ['https://avatars.githubusercontent.com/u/179229932'],
    },
    features: {
      socials: [],
      email: false,
      analytics: false,
      swaps: false,
      onramp: false,
      send: false,
      history: false,
      smartSessions: false,
    },
    themeMode: 'light',
    themeVariables: {
      '--w3m-accent': '#7b3fe4',
    },
    termsConditionsUrl: urlOrUndefined(EXTERNAL_LINKS.TERMS_OF_USE),
    privacyPolicyUrl: urlOrUndefined(EXTERNAL_LINKS.PRIVACY_POLICY),
    featuredWalletIds: [walletIds.METAMASK],
  });

  isAppKitInitialized = true;
};

if (!IS_E2E_ENABLED && wagmiSetup.wagmiAdapter) {
  initializeAppKit(wagmiSetup.wagmiAdapter);
}

const useCurrentChain = ({ status, chainId }: { status: string; chainId: number }) => {
  const chains = useChains();

  return useMemo(
    () => (status === 'connected' ? chains.find((chain) => chain.id === chainId) : undefined),
    [status, chains, chainId],
  );
};

const ProdWalletProvider = ({ children }: { readonly children: ReactNode }) => {
  const { open } = useAppKit();
  const { disconnect } = useAppKitDisconnect();
  const { walletInfo } = useWalletInfo();
  const { status, address } = useAppKitAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const currentChain = useCurrentChain({ status: status ?? 'disconnected', chainId });

  const value = useMemo<WalletContextValue>(
    () => ({
      address: address ?? '',
      status: status ?? 'disconnected',
      chainId: status === 'connected' ? chainId : undefined,
      chain: currentChain,
      walletInfo,
      walletIcon: walletInfo?.icon,
      connect: () => open({ view: 'Connect' }),
      disconnect,
      switchNetwork: (target) => {
        try {
          switchChain({ chainId: target });
        } catch (error) {
          console.error('Failed to switch chain', error);
        }
      },
    }),
    [address, chainId, currentChain, disconnect, open, status, switchChain, walletInfo],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

const E2EWalletProvider = ({ children }: { readonly children: ReactNode }) => {
  const chainId = useChainId();
  const [isConnected, setIsConnected] = useState(false);
  const status = isConnected ? 'connected' : 'disconnected';
  const currentChain = useCurrentChain({ status, chainId });

  const value = useMemo<WalletContextValue>(
    () => ({
      address: isConnected ? (e2eWalletAddress ?? '') : '',
      status,
      chainId: status === 'connected' ? chainId : undefined,
      chain: currentChain,
      walletInfo: undefined,
      walletIcon: undefined,
      connect: () => setIsConnected(true),
      disconnect: () => setIsConnected(false),
      // no-op for E2E
      switchNetwork: () => () => {},
    }),
    [chainId, currentChain, isConnected, status],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

const WalletProvider = ({ children }: { children: ReactNode }) => (
  <WagmiProvider config={wagmiSetup.config}>
    <QueryClientProvider client={queryClient}>
      {IS_E2E_ENABLED ? (
        <E2EWalletProvider>{children}</E2EWalletProvider>
      ) : (
        <ProdWalletProvider>{children}</ProdWalletProvider>
      )}
    </QueryClientProvider>
  </WagmiProvider>
);

export { WalletProvider };
