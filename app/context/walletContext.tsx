'use client';

import type { ConnectedWalletInfo } from '@reown/appkit/react';
import type { Chain } from 'viem';

import { createContext, useContext } from 'react';

export type WalletContextValue = {
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
  switchNetwork: () => {}
});

const useWallet = () => useContext(WalletContext);

export { WalletContext, useWallet };
