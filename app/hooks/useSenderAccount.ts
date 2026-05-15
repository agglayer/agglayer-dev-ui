'use client';

import type { Address } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

import { e2eLocalAccount } from '@/app/context/e2eAccount';
import { useWallet } from '@/app/context/walletContext';
import { isValidEthereumAddress } from '@/app/utils/address';
import { useMemo } from 'react';

type SenderAccount = Address | PrivateKeyAccount;

export const useSenderAccount = (): SenderAccount | undefined => {
  const { address, status } = useWallet();

  return useMemo(() => {
    if (status !== 'connected') return undefined;
    if (e2eLocalAccount) return e2eLocalAccount;
    return isValidEthereumAddress(address) ? address : undefined;
  }, [address, status]);
};
