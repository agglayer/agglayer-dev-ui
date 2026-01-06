'use client';

import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useChainId, useChains, useSwitchChain, WagmiProvider } from 'wagmi';
import type { Chain } from 'viem';
import {
  mainnet,
  sepolia,
  polygon,
  polygonZkEvm,
  polygonAmoy,
  xLayer,
  katana,
  ternoa,
  type AppKitNetwork,
} from '@reown/appkit/networks';
import type { ConnectedWalletInfo } from '@reown/appkit/react';
import { createAppKit, useAppKit, useAppKitAccount, useDisconnect, useWalletInfo } from '@reown/appkit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { wagmiAdapter, projectId } from '@/app/config/wagmiConfig';
import { EXTERNAL_LINKS } from '@/app/constants/externalLinks';

const queryClient = new QueryClient();

// Custom network definitions
const forknet: AppKitNetwork = {
  id: 8338,
  name: 'Forknet',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://rpc-forknet.t.conduit.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Forkscan',
      url: 'https://forkscan.org/',
    },
  },
};

// walletIds
// https://docs.reown.com/cloud/wallets/wallet-list
const walletIds = {
  METAMASK: 'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
  COINBASE: 'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa',
  RABBY: '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1',
};

createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: [mainnet, polygon, polygonAmoy, sepolia, xLayer, polygonZkEvm, katana, ternoa, forknet],
  defaultNetwork: mainnet,
  metadata: {
    name: 'bridge-hub-ui',
    description: 'Bridge Hub UI',
    url: 'https://ui.agglayer.dev',
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
  termsConditionsUrl: EXTERNAL_LINKS.POLYGON_TERMS_OF_USE,
  privacyPolicyUrl: EXTERNAL_LINKS.POLYGON_PRIVACY_POLICY,
  featuredWalletIds: [walletIds.METAMASK],
});

type WalletContextValue = {
  address: string;
  status: 'connected' | 'disconnected' | 'reconnecting' | 'connecting';
  chainId?: number;
  chain?: Chain;
  walletInfo?: ConnectedWalletInfo;
  walletIcon?: string;
  connect: () => void;
  disconnect: () => void;
  switchNetwork: (chainId: number) => void;
};

const WalletContext = createContext<WalletContextValue>({
  address: '',
  status: 'disconnected',
  chainId: undefined,
  chain: undefined,
  walletInfo: undefined,
  walletIcon: undefined,
  connect: () => {},
  disconnect: () => {},
  switchNetwork: () => {},
});

function WalletProviderInternal({ children }: { readonly children: ReactNode }) {
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { walletInfo } = useWalletInfo();
  const { status, address } = useAppKitAccount();
  const chainId = useChainId();
  const chains = useChains();
  const { switchChain } = useSwitchChain();

  const currentChain = useMemo(
    () => (status === 'connected' ? chains.find((chain) => chain.id === chainId) : undefined),
    [status, chains, chainId],
  );

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
        } catch {}
      },
    }),
    [status, address, chainId, currentChain, walletInfo, disconnect, open, switchChain],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

const WalletProvider = ({ children }: { children: ReactNode }) => (
  <WagmiProvider config={wagmiAdapter.wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <WalletProviderInternal>{children}</WalletProviderInternal>
    </QueryClientProvider>
  </WagmiProvider>
);

const useWallet = () => useContext(WalletContext);

export { useWallet, WalletContext, WalletProvider };
