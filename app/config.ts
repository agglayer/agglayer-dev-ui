import { katana, mainnet, polygonZkEvmCardona, sepolia } from 'wagmi/chains';
import type { Chain } from 'wagmi/chains';
import { ICONS } from '@/app/constants/icons';
import { createChainEntry, toNonEmptyChainArray, toProofApiUrl } from '@/app/utils/config';
import type { AppMode, AppModeConfig } from '@/app/types/appMode';
import type { ChainEntry } from '@/app/types/config';

export const customRpcUrls = {
  // Example:
  // 'eip155:1234': [{ url: 'https://rpc.example.org' }],
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

export const EXTERNAL_LINKS = Object.freeze({
  PRIVACY_POLICY: 'https://polygon.technology/privacy-policy',
  TERMS_OF_USE: 'https://polygon.technology/terms-of-use',
  CONTACT_SUPPORT: 'https://support.polygon.technology/support/home',
} as const);

const MAINNET = createChainEntry({
  wagmi: mainnet,
  icon: ICONS.ethereum,
  networkId: 0,
  isTestnet: false,
  eta: 20,
});

const KATANA = createChainEntry({
  wagmi: katana,
  icon: ICONS.katana,
  networkId: 20,
  isTestnet: false,
  eta: 180,
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
  KATANA,
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
    chains: [MAINNET.app, KATANA.app, FORKNET.app],
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

export const ALL_WAGMI_CHAINS: readonly [Chain, ...Chain[]] = toNonEmptyChainArray(
  Object.values(CHAIN_REGISTRY).map((entry) => entry.wagmi),
);
