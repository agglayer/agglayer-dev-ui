import { ICONS } from '@/app/constants/icons';
import { AppChain, AppMode, AppModeConfig } from '@/app/types/app-mode';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import type { Chain } from 'wagmi/chains';
import { mainnet, sepolia, polygonZkEvm, polygonZkEvmCardona, xLayer, katana, ternoa } from 'wagmi/chains';

type ChainEntry = {
  wagmi: Chain;
  app: AppChain;
};

type ChainEntryParams = {
  wagmi: Chain;
  icon: string;
  networkId: number;
  isTestnet: boolean;
  eta: number;
  rpcUrl?: string;
  explorer?: string;
  nativeLogoURI?: string;
};

const createChainEntry = (params: ChainEntryParams): ChainEntry => ({
  wagmi: params.wagmi,
  app: {
    id: params.wagmi.id,
    name: params.wagmi.name,
    icon: params.icon,
    explorer: params.explorer ?? params.wagmi.blockExplorers?.default?.url ?? '',
    networkId: params.networkId,
    isTestnet: params.isTestnet,
    rpcUrl: params.rpcUrl ?? params.wagmi.rpcUrls.default.http[0] ?? '',
    eta: params.eta,
    nativeCurrency: {
      address: ZERO_ADDRESS,
      decimals: params.wagmi.nativeCurrency.decimals,
      name: params.wagmi.nativeCurrency.name,
      symbol: params.wagmi.nativeCurrency.symbol,
      logoURI: params.nativeLogoURI ?? ICONS.ethereum,
    },
  },
});

export const BRIDGE_HUB_API_BASE_URL = 'https://bridge-hub-api.polygon.technology';

const toProofApiUrl = (mode: AppMode): string => `${BRIDGE_HUB_API_BASE_URL}/${mode}/`;

// zkevm rpc urls current issue with walletconnect rpc always failing
const polygonZkEvmRpcEndpoints = [
  'https://zkevm-rpc.com',
  'https://endpoints.omniatech.io/v1/polygon-zkevm/mainnet/public',
  'https://polygon-zkevm.drpc.org',
  'https://polygon-zkevm-public.nodies.app',
  'https://1rpc.io/polygon/zkevm',
];

export const customRpcUrls = {
  'eip155:1101': polygonZkEvmRpcEndpoints.map((url) => ({ url })),
};

const polygonZkEvmWagmi: Chain = {
  ...polygonZkEvm,
  rpcUrls: {
    default: {
      http: polygonZkEvmRpcEndpoints,
    },
    public: {
      http: polygonZkEvmRpcEndpoints,
    },
  },
};

const forknetWagmi: Chain = {
  id: 8338,
  name: 'Forknet',
  rpcUrls: {
    default: { http: ['https://rpc-forknet.t.conduit.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Forkscan', url: 'https://forkscan.org/' },
  },
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};

const bokutoWagmi: Chain = {
  id: 737373,
  name: 'Bokuto',
  rpcUrls: {
    default: { http: ['https://rpc-katana-bokuto.t.conduit.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Bokutoscan', url: 'https://bokuto.katanascan.com/' },
  },
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};

const MAINNET = createChainEntry({
  wagmi: mainnet,
  icon: ICONS.ethereum,
  networkId: 0,
  isTestnet: false,
  eta: 20,
});

const POLYGON_ZKEVM = createChainEntry({
  wagmi: polygonZkEvmWagmi,
  icon: ICONS.zkevm,
  networkId: 1,
  isTestnet: false,
  eta: 180,
  rpcUrl: polygonZkEvmRpcEndpoints[0],
});

const XLAYER = createChainEntry({
  wagmi: xLayer,
  icon: ICONS.xlayer,
  networkId: 3,
  isTestnet: false,
  eta: 180,
  nativeLogoURI: ICONS.xlayerToken,
});

const KATANA = createChainEntry({
  wagmi: katana,
  icon: ICONS.katana,
  networkId: 20,
  isTestnet: false,
  eta: 180,
});

const TERNOA = createChainEntry({
  wagmi: ternoa,
  icon: ICONS.ternoa,
  networkId: 13,
  isTestnet: false,
  eta: 180,
  nativeLogoURI: ICONS.ternoa,
});

const FORKNET = createChainEntry({
  wagmi: forknetWagmi,
  icon: ICONS.forknet,
  networkId: 22,
  isTestnet: false,
  eta: 180,
});

const SEPOLIA = createChainEntry({
  wagmi: sepolia,
  icon: ICONS.ethereum,
  networkId: 0,
  isTestnet: true,
  eta: 20,
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
});

const POLYGON_ZKEVM_CARDONA = createChainEntry({
  wagmi: polygonZkEvmCardona,
  icon: ICONS.zkevm,
  networkId: 1,
  isTestnet: true,
  eta: 180,
});

const BOKUTO = createChainEntry({
  wagmi: bokutoWagmi,
  icon: ICONS.bokuto,
  networkId: 37,
  isTestnet: true,
  eta: 180,
});

const CHAIN_REGISTRY: Record<string, ChainEntry> = {
  MAINNET,
  POLYGON_ZKEVM,
  XLAYER,
  KATANA,
  TERNOA,
  FORKNET,
  SEPOLIA,
  POLYGON_ZKEVM_CARDONA,
  BOKUTO,
};

export const DEFAULT_APP_MODE: AppMode = 'testnet';

export const APP_MODE_CONFIG: Record<AppMode, AppModeConfig> = {
  mainnet: {
    label: 'Mainnet',
    bridgeAddress: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe',
    proofApiUrl: toProofApiUrl('mainnet'),
    defaultFromChainId: MAINNET.app.id,
    defaultToChainId: KATANA.app.id,
    chains: [MAINNET.app, POLYGON_ZKEVM.app, XLAYER.app, KATANA.app, TERNOA.app, FORKNET.app],
  },
  testnet: {
    label: 'Testnet',
    bridgeAddress: '0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582',
    proofApiUrl: toProofApiUrl('testnet'),
    defaultFromChainId: SEPOLIA.app.id,
    defaultToChainId: POLYGON_ZKEVM_CARDONA.app.id,
    chains: [SEPOLIA.app, POLYGON_ZKEVM_CARDONA.app, BOKUTO.app],
  },
  devnet: {
    label: 'Devnet',
    bridgeAddress: '0x1348947e282138d8f377b467F7D9c2EB0F335d1f',
    proofApiUrl: toProofApiUrl('devnet'),
    chains: [],
  },
};

const toNonEmptyChainArray = (chains: Chain[]): readonly [Chain, ...Chain[]] => {
  const [first, ...rest] = chains;
  if (!first) throw new Error('APP_CONFIG_INVALID: no wagmi chains configured');
  return [first, ...rest];
};

export const ALL_WAGMI_CHAINS: readonly [Chain, ...Chain[]] = toNonEmptyChainArray(
  Object.values(CHAIN_REGISTRY).map((entry) => entry.wagmi),
);
