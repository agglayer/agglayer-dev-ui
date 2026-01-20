'use client';

import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { WagmiProvider, createConfig, http, useAccount, useChainId, useChains, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { mock } from 'wagmi/connectors';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { QueryClientProvider } from '@tanstack/react-query';
import { ANVIL_DEFAULT_PRIVATE_KEY, ANVIL_DEFAULT_RPC_URL } from '@/app/constants/e2e';
import { WalletContext, type WalletContextValue } from '@/app/context/wallet-context';
import { queryClient } from '@/app/context/wagmi-config';

type Connectors = ReturnType<typeof useConnect>['connectors'];
type Disconnectors = ReturnType<typeof useDisconnect>['disconnect'];
type SwitchChainFn = ReturnType<typeof useSwitchChain>['switchChain'];

const e2eAccount = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
const isE2EWalletEnabled = process.env.NEXT_PUBLIC_E2E_ENABLED === 'true';

const e2eConfig = createConfig({
  chains: [foundry],
  connectors: [mock({ accounts: [e2eAccount.address] })],
  transports: {
    [foundry.id]: http(ANVIL_DEFAULT_RPC_URL),
  },
});

const buildConnect = ({ connect, connectors }: { connect: ReturnType<typeof useConnect>['connect']; connectors: Connectors }) => {
  return () => {
    const connector = connectors[0];
    if (!connector) return;
    connect({ connector });
  };
};

const buildDisconnect = ({ disconnect }: { disconnect: Disconnectors }) => {
  return () => {
    disconnect();
  };
};

const buildSwitchNetwork = ({ switchChain }: { switchChain: SwitchChainFn }) => {
  return (target: number) => {
    if (!switchChain) return;
    try {
      switchChain({ chainId: target });
    } catch {}
  };
};

const E2EWalletProviderInternal = ({ children }: { readonly children: ReactNode }) => {
  const { address, status } = useAccount();
  const chainId = useChainId();
  const chains = useChains();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
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
      walletInfo: undefined,
      walletIcon: undefined,
      connect: buildConnect({ connect, connectors }),
      disconnect: buildDisconnect({ disconnect }),
      switchNetwork: buildSwitchNetwork({ switchChain }),
    }),
    [address, status, chainId, currentChain, connect, connectors, disconnect, switchChain],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

const E2EWalletProvider = ({ children }: { children: ReactNode }) => {
  return (
    <WagmiProvider config={e2eConfig}>
      <QueryClientProvider client={queryClient}>
        <E2EWalletProviderInternal>{children}</E2EWalletProviderInternal>
      </QueryClientProvider>
    </WagmiProvider>
  );
};

export { E2EWalletProvider, isE2EWalletEnabled };
