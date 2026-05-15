import { APP_MODE_CONFIG } from '@/app/config';
import { E2E_FROM_CHAIN_ID } from '@/app/constants/e2e';

export const getE2EFromChainRpcUrl = (): string => {
  for (const config of Object.values(APP_MODE_CONFIG)) {
    const chain = config.chains.find((chain) => chain.id === E2E_FROM_CHAIN_ID);
    if (chain) return chain.rpcUrl;
  }

  throw new Error(`E2E_RPC_MISSING: chain ${E2E_FROM_CHAIN_ID} is not configured in any app mode`);
};
