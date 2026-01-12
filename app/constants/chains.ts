import type { ChainMetadata } from '@/app/types/chain';

export const SUPPORTED_CHAINS: ChainMetadata[] = [
  {
    id: 1,
    name: 'Ethereum',
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    explorer: 'https://etherscan.io',
    networkId: 0,
    nativeCurrency: {
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    },
  },
  {
    id: 1101,
    name: 'Polygon zkEVM',
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/zkevm.svg',
    explorer: 'https://www.oklink.com/polygon-zkevm',
    networkId: 1,
    nativeCurrency: {
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    },
  },
  {
    id: 196,
    name: 'X Layer',
    icon: 'https://assets.polygon.technology/tokenAssets/okb.svg',
    explorer: 'https://www.oklink.com/x-layer',
    networkId: 3,
    nativeCurrency: {
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      name: 'OKB',
      symbol: 'OKB',
      logoURI: 'https://assets.polygon.technology/tokenAssets/okb.png',
    },
  },
  {
    id: 747474,
    name: 'Katana',
    icon: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/katana.svg',
    explorer: 'https://katanascan.com',
    networkId: 20,
    nativeCurrency: {
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    },
  },
  {
    id: 752025,
    name: 'Ternoa',
    icon: 'https://assets.polygon.technology/tokenAssets/caps.svg',
    explorer: 'https://explorer-mainnet.zkevm.ternoa.network',
    networkId: 13,
    nativeCurrency: {
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      name: 'Capsule Coin',
      symbol: 'CAPS',
      logoURI: 'https://assets.polygon.technology/tokenAssets/caps.svg',
    },
  },
  {
    id: 8338,
    name: 'Forknet',
    isTestnet: true,
    icon: 'https://explorer-forknet.t.conduit.xyz/assets/configs/network_icon_dark.svg',
    explorer: 'https://forkscan.org',
    networkId: 22,
    nativeCurrency: {
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
      logoURI: 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg',
    },
  },
];

export const DEFAULT_FROM_CHAIN_ID: number = 1;
export const DEFAULT_TO_CHAIN_ID: number = 1101;

export const getChainById = (chainId: number) => SUPPORTED_CHAINS.find((chain) => chain.id === chainId);

export const getChainByNetworkId = (networkId: number) =>
  SUPPORTED_CHAINS.find((chain) => chain.networkId === networkId);
