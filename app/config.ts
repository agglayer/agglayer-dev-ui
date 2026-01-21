import { ICONS } from '@/app/constants/icons';
import { AppChain, AppMode, AppModeConfig } from '@/app/types/app-mode';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import type { Chain } from 'wagmi/chains';
import { mainnet, sepolia, polygonZkEvm, polygonZkEvmCardona, xLayer, katana, ternoa } from 'wagmi/chains';

const APP_MODES: AppMode[] = ['mainnet', 'testnet', 'devnet'];

type ChainEntry = {
  wagmi: Chain;
  app: AppChain;
};

// zkevm rpc urls current issue with walletconnect rpc always failing
export const polygonZkEvmRpcEndpoints = [
  'https://zkevm-rpc.com',
  'https://endpoints.omniatech.io/v1/polygon-zkevm/mainnet/public',
  'https://polygon-zkevm.drpc.org',
  'https://polygon-zkevm-public.nodies.app',
  'https://1rpc.io/polygon/zkevm',
];

export const customRpcUrls = {
  'eip155:1101': polygonZkEvmRpcEndpoints.map((url) => ({ url })),
};

// Chain registry: each entry defines wagmi + app-specific metadata in one place.
const MAINNET: ChainEntry = {
  wagmi: mainnet,
  app: {
    id: mainnet.id,
    name: mainnet.name,
    icon: ICONS.ethereum,
    explorer: mainnet.blockExplorers?.default?.url ?? '',
    networkId: 0,
    isTestnet: false,
    rpcUrl: mainnet.rpcUrls.default.http[0],
    eta: 20,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: mainnet.nativeCurrency.decimals,
      name: mainnet.nativeCurrency.name,
      symbol: mainnet.nativeCurrency.symbol,
      logoURI: ICONS.ethereum,
    },
  },
};

const POLYGON_ZKEVM: ChainEntry = {
  wagmi: {
    ...polygonZkEvm,
    rpcUrls: {
      default: {
        http: polygonZkEvmRpcEndpoints,
      },
      public: {
        http: polygonZkEvmRpcEndpoints,
      },
    },
  },
  app: {
    id: polygonZkEvm.id,
    name: polygonZkEvm.name,
    icon: ICONS.zkevm,
    explorer: polygonZkEvm.blockExplorers?.default?.url ?? '',
    networkId: 1,
    isTestnet: false,
    rpcUrl: polygonZkEvmRpcEndpoints[0],
    eta: 180,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: polygonZkEvm.nativeCurrency.decimals,
      name: polygonZkEvm.nativeCurrency.name,
      symbol: polygonZkEvm.nativeCurrency.symbol,
      logoURI: ICONS.ethereum,
    },
  },
};

const XLAYER: ChainEntry = {
  wagmi: xLayer,
  app: {
    id: xLayer.id,
    name: xLayer.name,
    icon: ICONS.xlayer,
    explorer: xLayer.blockExplorers?.default?.url ?? '',
    networkId: 3,
    isTestnet: false,
    rpcUrl: xLayer.rpcUrls.default.http[0],
    eta: 180,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: xLayer.nativeCurrency.decimals,
      name: xLayer.nativeCurrency.name,
      symbol: xLayer.nativeCurrency.symbol,
      logoURI: ICONS.xlayerToken,
    },
  },
};

const KATANA: ChainEntry = {
  wagmi: katana,
  app: {
    id: katana.id,
    name: katana.name,
    icon: ICONS.katana,
    explorer: katana.blockExplorers?.default?.url ?? '',
    networkId: 20,
    isTestnet: false,
    rpcUrl: katana.rpcUrls.default.http[0],
    eta: 180,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: katana.nativeCurrency.decimals,
      name: katana.nativeCurrency.name,
      symbol: katana.nativeCurrency.symbol,
      logoURI: ICONS.ethereum,
    },
  },
};

const TERNOA: ChainEntry = {
  wagmi: ternoa,
  app: {
    id: ternoa.id,
    name: ternoa.name,
    icon: ICONS.ternoa,
    explorer: ternoa.blockExplorers?.default?.url ?? '',
    networkId: 13,
    isTestnet: false,
    rpcUrl: ternoa.rpcUrls.default.http[0],
    eta: 180,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: ternoa.nativeCurrency.decimals,
      name: ternoa.nativeCurrency.name,
      symbol: ternoa.nativeCurrency.symbol,
      logoURI: ICONS.ternoa,
    },
  },
};

const FORKNET: ChainEntry = {
  wagmi: {
    id: 8338,
    name: 'Forknet',
    rpcUrls: {
      default: { http: ['https://rpc-forknet.t.conduit.xyz'] },
    },
    blockExplorers: {
      default: { name: 'Forkscan', url: 'https://forkscan.org/' },
    },
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  app: {
    id: 8338,
    name: 'Forknet',
    icon: ICONS.forknet,
    explorer: 'https://forkscan.org/',
    networkId: 22,
    isTestnet: false,
    rpcUrl: 'https://rpc-forknet.t.conduit.xyz',
    eta: 180,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: ICONS.ethereum,
    },
  },
};

const SEPOLIA: ChainEntry = {
  wagmi: sepolia,
  app: {
    id: sepolia.id,
    name: sepolia.name,
    icon: ICONS.ethereum,
    explorer: sepolia.blockExplorers?.default?.url ?? '',
    networkId: 0,
    isTestnet: true,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    eta: 20,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: sepolia.nativeCurrency.decimals,
      name: sepolia.nativeCurrency.name,
      symbol: sepolia.nativeCurrency.symbol,
      logoURI: ICONS.ethereum,
    },
  },
};

const POLYGON_ZKEVM_CARDONA: ChainEntry = {
  wagmi: polygonZkEvmCardona,
  app: {
    id: polygonZkEvmCardona.id,
    name: polygonZkEvmCardona.name,
    icon: ICONS.zkevm,
    explorer: polygonZkEvmCardona.blockExplorers?.default?.url ?? '',
    networkId: 1,
    isTestnet: true,
    rpcUrl: polygonZkEvmCardona.rpcUrls.default.http[0],
    eta: 180,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: polygonZkEvmCardona.nativeCurrency.decimals,
      name: polygonZkEvmCardona.nativeCurrency.name,
      symbol: polygonZkEvmCardona.nativeCurrency.symbol,
      logoURI: ICONS.ethereum,
    },
  },
};

const BOKUTO: ChainEntry = {
  wagmi: {
    id: 737373,
    name: 'Bokuto',
    rpcUrls: {
      default: { http: ['rpc-katana-bokuto.t.conduit.xyz'] },
    },
    blockExplorers: {
      default: { name: 'Bokutoscan', url: 'https://bokuto.katanascan.com/' },
    },
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  app: {
    id: 737373,
    name: 'Bokuto',
    icon: ICONS.bokuto,
    explorer: 'https://bokuto.katanascan.com/',
    networkId: 37,
    isTestnet: true,
    rpcUrl: 'rpc-katana-bokuto.t.conduit.xyz',
    eta: 180,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: ICONS.ethereum,
    },
  },
};

export const DEFAULT_APP_MODE: AppMode = 'testnet';

export const APP_MODE_CONFIG: Record<AppMode, AppModeConfig> = {
  mainnet: {
    label: 'Mainnet',
    bridgeAddress: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe',
    proofApiUrl: 'https://bridge-hub-api.polygon.technology/mainnet/',
    defaultFromChainId: MAINNET.app.id,
    defaultToChainId: KATANA.app.id,
    chains: [
      MAINNET.app,
      POLYGON_ZKEVM.app,
      XLAYER.app,
      KATANA.app,
      TERNOA.app,
      FORKNET.app,
    ],
  },
  testnet: {
    label: 'Testnet',
    bridgeAddress: '0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582',
    proofApiUrl: 'https://bridge-hub-api.polygon.technology/testnet/',
    defaultFromChainId: SEPOLIA.app.id,
    defaultToChainId: POLYGON_ZKEVM_CARDONA.app.id,
    chains: [
      SEPOLIA.app,
      POLYGON_ZKEVM_CARDONA.app,
      BOKUTO.app,
    ],
  },
  devnet: {
    label: 'Devnet',
    bridgeAddress: '0x1348947e282138d8f377b467F7D9c2EB0F335d1f',
    proofApiUrl: 'https://bridge-hub-api.polygon.technology/devnet/',
    defaultFromChainId: SEPOLIA.app.id,
    defaultToChainId: POLYGON_ZKEVM_CARDONA.app.id,
    chains: [],
  },
};

export const ALL_WAGMI_CHAINS: readonly [Chain, ...Chain[]] = [
  MAINNET.wagmi,
  POLYGON_ZKEVM.wagmi,
  XLAYER.wagmi,
  KATANA.wagmi,
  TERNOA.wagmi,
  FORKNET.wagmi,
  SEPOLIA.wagmi,
  POLYGON_ZKEVM_CARDONA.wagmi,
  BOKUTO.wagmi,
];

const getUniqueIds = (ids: number[]): number[] => ids.filter((id, index) => ids.indexOf(id) === index);

const getAppChainIds = (configs: Record<AppMode, AppModeConfig>): number[] =>
  getUniqueIds(APP_MODES.flatMap((mode) => configs[mode].chains.map((chain) => chain.id)));

const getWagmiChainIds = (chains: readonly Chain[]): number[] =>
  getUniqueIds(chains.map((chain) => chain.id));

const getInvalidDefaultIds = (configs: Record<AppMode, AppModeConfig>): string[] =>
  APP_MODES.flatMap((mode) => {
    const config = configs[mode];
    if (!config.chains.length) return [];
    const chainIds = config.chains.map((chain) => chain.id);
    const defaults = [config.defaultFromChainId, config.defaultToChainId];
    return defaults.filter((id) => !chainIds.includes(id)).map((id) => `${mode}:${id}`);
  });

const validateConfig = (configs: Record<AppMode, AppModeConfig>, chains: readonly Chain[]) => {
  const appChainIds = getAppChainIds(configs);
  const wagmiChainIds = getWagmiChainIds(chains);

  const missingInWagmi = appChainIds.filter((id) => !wagmiChainIds.includes(id));
  const missingInApp = wagmiChainIds.filter((id) => !appChainIds.includes(id));
  const invalidDefaults = getInvalidDefaultIds(configs);

  const errors = [
    missingInWagmi.length ? `Missing in ALL_WAGMI_CHAINS: ${missingInWagmi.join(', ')}` : '',
    missingInApp.length ? `Missing in APP_MODE_CONFIG: ${missingInApp.join(', ')}` : '',
    invalidDefaults.length ? `Default chain IDs not in mode chains: ${invalidDefaults.join(', ')}` : '',
  ].filter(Boolean);

  if (!errors.length) return;
  throw new Error(`APP_CONFIG_INVALID: ${errors.join(' | ')}`);
};

validateConfig(APP_MODE_CONFIG, ALL_WAGMI_CHAINS);
