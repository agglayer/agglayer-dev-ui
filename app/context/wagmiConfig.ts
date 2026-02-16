import { QueryClient } from '@tanstack/react-query';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { ALL_WAGMI_CHAINS, customRpcUrls } from '@/app/config';

const projectId = process.env.NEXT_PUBLIC_PROJECT_ID!;
const queryClient = new QueryClient();

const wagmiAdapter = new WagmiAdapter({
  ssr: true,
  projectId,
  customRpcUrls,
  networks: [...ALL_WAGMI_CHAINS()],
});

export { projectId, queryClient, wagmiAdapter };
