import { ICONS } from '@/app/constants/icons';
import { AppChain, AppMode, AppModeConfig } from '@/app/types/app-mode';
import { ZERO_ADDRESS } from '@/app/types/bridge';
import type { Chain } from 'wagmi/chains';
import { mainnet, sepolia, polygonZkEvm, polygonZkEvmCardona, xLayer, katana, ternoa } from 'wagmi/chains';

export const forknet: Chain = {
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

// zkevm rpc urls current issue with walletconnect rpc always failing
export const polygonZkEvmRpcEndpoints = [
  'https://zkevm-rpc.com',
  'https://endpoints.omniatech.io/v1/polygon-zkevm/mainnet/public',
  'https://polygon-zkevm.drpc.org',
  'https://polygon-zkevm-public.nodies.app',
  'https://1rpc.io/polygon/zkevm',
];

// add custom chains
export const polygonZkEvmWithFallbackRpcs: Chain = {
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

export const customRpcUrls = {
  'eip155:1101': polygonZkEvmRpcEndpoints.map((url) => ({ url })),
};

const createChain = (
  chain: Chain,
  networkId: number,
  icon: string,
  nativeLogo: string,
  rpcOverride?: string,
): AppChain => ({
  id: chain.id,
  name: chain.name,
  icon,
  explorer: chain.blockExplorers?.default?.url ?? '',
  networkId,
  isTestnet: (chain as { testnet?: boolean }).testnet ?? false,
  rpcUrl: rpcOverride ?? chain.rpcUrls.default.http[0],
  nativeCurrency: {
    address: ZERO_ADDRESS,
    decimals: chain.nativeCurrency.decimals,
    name: chain.nativeCurrency.name,
    symbol: chain.nativeCurrency.symbol,
    logoURI: nativeLogo,
  },
});

export const DEFAULT_APP_MODE: AppMode = 'testnet';

export const APP_MODE_CONFIG: Record<AppMode, AppModeConfig> = {
  mainnet: {
    label: 'Mainnet',
    bridgeAddress: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe',
    proofApiUrl: 'https://bridge-hub-api.polygon.technology/mainnet/',
    defaultFromChainId: mainnet.id,
    defaultToChainId: katana.id,
    chains: [
      createChain(mainnet, 0, ICONS.ethereum, ICONS.ethereum),
      createChain(polygonZkEvmWithFallbackRpcs, 1, ICONS.zkevm, ICONS.ethereum),
      createChain(xLayer, 3, ICONS.xlayer, ICONS.xlayerToken),
      createChain(katana, 20, ICONS.katana, ICONS.ethereum),
      createChain(ternoa, 13, ICONS.ternoa, ICONS.ternoa),
      createChain(forknet, 22, ICONS.forknet, ICONS.ethereum),
    ],
  },
  testnet: {
    label: 'Testnet',
    bridgeAddress: '0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582',
    proofApiUrl: 'https://bridge-hub-api.polygon.technology/testnet/',
    defaultFromChainId: sepolia.id,
    defaultToChainId: polygonZkEvmCardona.id,
    chains: [
      createChain(sepolia, 0, ICONS.ethereum, ICONS.ethereum, 'https://ethereum-sepolia-rpc.publicnode.com'),
      createChain(polygonZkEvmCardona, 1, ICONS.zkevm, ICONS.ethereum),
    ],
  },
  devnet: {
    label: 'Devnet',
    bridgeAddress: '0x1348947e282138d8f377b467F7D9c2EB0F335d1f',
    proofApiUrl: 'https://bridge-hub-api.polygon.technology/devnet/',
    defaultFromChainId: sepolia.id,
    defaultToChainId: polygonZkEvmCardona.id,
    chains: [],
  },
};

export const ALL_WAGMI_CHAINS: readonly [Chain, ...Chain[]] = [
  mainnet,
  polygonZkEvmWithFallbackRpcs,
  xLayer,
  katana,
  ternoa,
  forknet,
  sepolia,
  polygonZkEvmCardona,
];
