import { QueryClient } from '@tanstack/react-query';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createConfig, http } from 'wagmi';
import type { Config } from 'wagmi';
import type { Chain } from 'wagmi/chains';
import { ALL_WAGMI_CHAINS, APP_MODE_CONFIG, customRpcUrls } from '@/app/config';
import { E2E_APP_MODE, IS_E2E_ENABLED } from '@/app/constants/e2e';
import { isEnabledModeConfig } from '@/app/utils/appMode';
import { toNonEmptyChainArray } from '@/app/utils/config';

const projectId = process.env.NEXT_PUBLIC_PROJECT_ID!;

const queryClient = new QueryClient();

type WagmiSetup = {
  config: Config;
  wagmiAdapter?: WagmiAdapter;
};

const createProdWagmiSetup = (): WagmiSetup => {
  const wagmiAdapter = new WagmiAdapter({
    ssr: true,
    projectId,
    customRpcUrls,
    networks: [...ALL_WAGMI_CHAINS],
  });

  return {
    config: wagmiAdapter.wagmiConfig,
    wagmiAdapter,
  };
};

type HttpTransport = ReturnType<typeof http>;

const createTransportsByChainId = ({
  chains,
  resolveRpcUrl,
}: {
  chains: readonly [Chain, ...Chain[]];
  resolveRpcUrl: (chainId: number) => string;
}) => {
  return chains.reduce<Record<number, HttpTransport>>((acc, chain) => {
    acc[chain.id] = http(resolveRpcUrl(chain.id));
    return acc;
  }, {});
};

const createE2EWagmiSetup = (): WagmiSetup => {
  const e2eModeConfig = APP_MODE_CONFIG[E2E_APP_MODE];
  if (!isEnabledModeConfig(e2eModeConfig)) {
    throw new Error(`E2E_WAGMI_INVALID_CONFIG: ${E2E_APP_MODE} mode must have at least two chains`);
  }

  const e2eChainIds = new Set(e2eModeConfig.chains.map((chain) => chain.id));
  const e2eWagmiChains = toNonEmptyChainArray(ALL_WAGMI_CHAINS.filter((chain) => e2eChainIds.has(chain.id)));
  const e2eRpcUrlByChainId = new Map<number, string>(
    e2eModeConfig.chains.map((chain) => [chain.id, chain.rpcUrl]),
  );

  const resolveE2ERpcUrl = (chainId: number): string => {
    const rpcUrl = e2eRpcUrlByChainId.get(chainId);
    if (rpcUrl) return rpcUrl;

    throw new Error(`E2E_WAGMI_RPC_MISSING: ${chainId}`);
  };

  const config = createConfig({
    chains: e2eWagmiChains,
    transports: createTransportsByChainId({ chains: e2eWagmiChains, resolveRpcUrl: resolveE2ERpcUrl }),
  });

  return { config };
};

const wagmiSetup = IS_E2E_ENABLED ? createE2EWagmiSetup() : createProdWagmiSetup();

export { projectId, queryClient, wagmiSetup };
