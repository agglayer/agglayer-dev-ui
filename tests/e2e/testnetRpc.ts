import { APP_MODE_CONFIG } from '@/app/config';
import { E2E_APP_MODE, E2E_FROM_CHAIN_ID } from '@/app/constants/e2e';

export const getE2EFromChainRpcUrl = (): string => {
  const fromChain = APP_MODE_CONFIG[E2E_APP_MODE].chains.find((chain) => chain.id === E2E_FROM_CHAIN_ID);
  if (!fromChain) {
    throw new Error(`E2E_TESTNET_RPC_MISSING: chain ${E2E_FROM_CHAIN_ID} is not configured for ${E2E_APP_MODE} mode`);
  }

  return fromChain.rpcUrl;
};
