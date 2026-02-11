import { APP_MODE_CONFIG } from '@/app/config';
import { E2E_FROM_CHAIN_ID } from '@/app/constants/e2e';

export const getE2EFromChainRpcUrl = (): string => {
  const fromChain = APP_MODE_CONFIG.testnet.chains.find((chain) => chain.id === E2E_FROM_CHAIN_ID);
  if (!fromChain) {
    throw new Error(`E2E_TESTNET_RPC_MISSING: chain ${E2E_FROM_CHAIN_ID} is not configured for testnet mode`);
  }

  return fromChain.rpcUrl;
};
