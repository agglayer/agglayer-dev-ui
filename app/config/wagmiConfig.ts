import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import type { Chain } from 'wagmi/chains';
import { mainnet, polygon, xLayer, polygonZkEvm, katana, ternoa, polygonAmoy, sepolia } from 'wagmi/chains';

export const forknet: Chain = {
  id: 8338,
  name: 'Forknet',
  rpcUrls: {
    default: { http: ['https://rpc-forknet.t.conduit.xyz'] },
  },
  blockExplorers: {
    default: {
      name: 'Forkscan',
      url: 'https://forkscan.org/',
    },
  },
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};

export const projectId = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID!;

export const wagmiAdapter = new WagmiAdapter({
  ssr: true,
  projectId,
  networks: [mainnet, sepolia, polygon, polygonAmoy, xLayer, polygonZkEvm, katana, ternoa, forknet],
});

export const wagmiAdapterConfig = wagmiAdapter.wagmiConfig;
