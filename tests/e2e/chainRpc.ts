import type { Chain } from 'wagmi/chains';

import { ALL_WAGMI_CHAINS } from '@/app/config';
import { E2E_FROM_CHAIN_ID } from '@/app/constants/e2e';

// Resolves the E2E "from" chain generically from config.json's chain
// registry (ALL_WAGMI_CHAINS spans every chain defined there, regardless of
// which app mode is currently active) instead of hardcoding a single
// testnet chain object -- this lets the same helper serve both devnet
// (DEVNET_L1, id 271828) and testnet (Sepolia, id 11155111) mode.
export const getE2EFromChain = (): Chain => {
  const chain = ALL_WAGMI_CHAINS.find((candidate) => candidate.id === E2E_FROM_CHAIN_ID);
  if (!chain) {
    throw new Error(
      `E2E_RPC_MISSING: chain ${E2E_FROM_CHAIN_ID} is not configured in config.json's chains. ` +
        'Run scripts/kurtosisDevnetEnv.mjs (devnet mode) or check E2E_FROM_CHAIN_ID (testnet mode).'
    );
  }
  return chain;
};

export const getE2EFromChainRpcUrl = (): string => {
  const chain = getE2EFromChain();
  const rpcUrl = chain.rpcUrls.default.http[0];
  if (!rpcUrl) {
    throw new Error(`E2E_RPC_MISSING: chain ${E2E_FROM_CHAIN_ID} has no configured rpcUrl`);
  }
  return rpcUrl;
};
