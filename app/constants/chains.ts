import type { ChainMetadata } from '@/app/types/chain';

export const SUPPORTED_CHAINS: ChainMetadata[] = [
  {
    id: 1,
    name: 'Ethereum',
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
  },
  {
    id: 11155111,
    name: 'Sepolia',
    isTestnet: true,
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
  },
  {
    id: 137,
    name: 'Polygon PoS',
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/polygon.svg',
  },
  {
    id: 80002,
    name: 'Polygon Amoy',
    isTestnet: true,
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/polygon.svg',
  },
  {
    id: 1101,
    name: 'Polygon zkEVM',
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/zkevm.svg',
  },
  {
    id: 196,
    name: 'X Layer',
    icon: 'https://assets.polygon.technology/tokenAssets/okb.svg',
  },
  {
    id: 747474,
    name: 'Katana',
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/katana.svg',
  },
  {
    id: 752025,
    name: 'Ternoa',
    icon: 'https://assets.polygon.technology/tokenAssets/caps.svg',
  },
  {
    id: 8338,
    name: 'Forknet',
    isTestnet: true,
    icon: 'https://explorer-forknet.t.conduit.xyz/assets/configs/network_icon_dark.svg',
  },
];

export const DEFAULT_FROM_CHAIN_ID: number = 1;
export const DEFAULT_TO_CHAIN_ID: number = 1101;

export const getChainById = (chainId: number) => SUPPORTED_CHAINS.find((chain) => chain.id === chainId);

export const mainnetChains = SUPPORTED_CHAINS.filter((chain) => !chain.isTestnet);
export const testnetChains = SUPPORTED_CHAINS.filter((chain) => chain.isTestnet);
