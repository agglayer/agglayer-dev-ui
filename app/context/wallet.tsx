'use client';

import type { ResolvedAppConfig } from '@/app/config';
import type { WalletContextValue } from '@/app/context/walletContext';
import type { ReactNode } from 'react';
import type { Chain } from 'wagmi/chains';

import {
  customRpcUrls,
  getAllWagmiChains,
  getDefaultWagmiChain,
  getExternalLinks
} from '@/app/config';
import { IS_E2E_ENABLED } from '@/app/constants/e2e';
import { e2eWalletAddress } from '@/app/context/e2eAccount';
import { WalletContext } from '@/app/context/walletContext';
import { isPlaceholderProjectId, resolveMetadataUrl } from '@/app/utils/reownConfig';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useDisconnect as useAppKitDisconnect,
  useWalletInfo
} from '@reown/appkit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChainId, useChains, useSwitchChain, WagmiProvider } from 'wagmi';

// projectId/isDegradedProjectId are env-derived (NEXT_PUBLIC_PROJECT_ID),
// not config -- they stay module-scope (design.md §2.1/§2.3).
const projectId = process.env.NEXT_PUBLIC_PROJECT_ID!;

const urlOrUndefined = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value;

// walletIds - https://docs.reown.com/cloud/wallets/wallet_list
const walletIds = {
  METAMASK: 'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
  COINBASE: 'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa',
  RABBY: '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1'
};

// With no real WalletConnect Cloud project id
// configured (the checked-in .env.example/.env.local literal, or an empty
// value), AppKit's own remote-config round trip to api.web3modal.org 403s
// (invalid projectId) on every load. The standing decision is to
// degrade gracefully rather than require a real id for local/dev use.
// `basic: true` is the narrowest documented AppKitOptions lever that does
// anything about this (see @reown/appkit's AppKitOptions.basic jsdoc): it
// skips AppKit's own `!options.basic` guard around fetching remote project
// config at init (eliminating the `/appkit/v1/config` 403 and its
// "[Reown Config] Failed to fetch remote project configuration" warning),
// and it trims the modal-open prefetch to skip network/connector image
// fetches (eliminating the `/public/getAssetImage/*` 403s). It does NOT
// touch wallet detection/connection: `ConnectionController.state.wcBasic`
// (what `basic: true` sets) is only read by the WalletConnect-explorer wallet
// list (recommended/featured/"All Wallets" screens, sourced from AppKit's
// own API) and by the unsupported-chain banner -- never by
// ConnectorController's EIP-6963/injected connector detection or the
// scaffold-ui Connect screen that renders it (verified against the
// installed @reown/appkit-controllers@1.8.19 / @reown/appkit-scaffold-ui
// sources; `wcBasic` does not appear anywhere in appkit-scaffold-ui). The
// injected-wallet connect flow this app actually relies on is therefore
// unaffected. Calls this can't reach (fetchUsage's unconditional
// `/appkit/v1/project-limits`, the featured/recommended `/getWallets`
// prefetch, WalletConnect's identity lookup, and AppKit's own
// mandatory-event analytics beacon) stay environmental/upstream.
//
// A real-shaped project id (anything other than the placeholder/empty) skips
// all of this and behaves exactly as before.
const isDegradedProjectId = isPlaceholderProjectId(projectId);

// createAppKit is a global side effect that needs config values
// (chains/defaultChain/externalLinks) that are only available once
// AppConfigGate has resolved -- so it can no longer run at module scope. It
// runs instead inside WalletProvider's render (a useMemo, not a useEffect:
// AppKitWalletProvider's child hooks -- useAppKit/useAppKitAccount/
// useWalletInfo -- run before this component's own effects would, so an
// effect-based init would leave them reading an uninitialized AppKit on the
// first child render). The module-scope flag makes it idempotent under
// StrictMode/concurrent-render double-invocation (design.md §2.2).
let appKitInitialized = false;

const ensureAppKit = (params: {
  chains: readonly [Chain, ...Chain[]];
  defaultChain: Chain;
  externalLinks: ResolvedAppConfig['externalLinks'];
  adapter: WagmiAdapter;
}): void => {
  if (appKitInitialized) return;
  appKitInitialized = true;

  createAppKit({
    adapters: [params.adapter],
    projectId,
    networks: [...params.chains],
    defaultNetwork: params.defaultChain,
    customRpcUrls,
    metadata: {
      name: 'agglayer-dev-ui',
      description: 'Agglayer Dev UI',
      url: resolveMetadataUrl(),
      icons: ['https://avatars.githubusercontent.com/u/179229932']
    },
    features: {
      socials: [],
      email: false,
      analytics: false,
      swaps: false,
      onramp: false,
      send: false,
      history: false,
      smartSessions: false
    },
    ...(isDegradedProjectId ? { basic: true } : {}),
    themeMode: 'light',
    themeVariables: {
      '--w3m-accent': '#7b3fe4'
    },
    termsConditionsUrl: urlOrUndefined(params.externalLinks.TERMS_OF_USE),
    privacyPolicyUrl: urlOrUndefined(params.externalLinks.PRIVACY_POLICY),
    featuredWalletIds: [walletIds.METAMASK]
  });
};

const useCurrentChain = ({ status, chainId }: { status: string; chainId: number }) => {
  const chains = useChains();

  return useMemo(
    () => (status === 'connected' ? chains.find((chain) => chain.id === chainId) : undefined),
    [status, chains, chainId]
  );
};

const AppKitWalletProvider = ({ children }: { readonly children: ReactNode }) => {
  const { open } = useAppKit();
  const { disconnect } = useAppKitDisconnect();
  const { walletInfo } = useWalletInfo();
  const { status, address } = useAppKitAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const currentChain = useCurrentChain({ status: status ?? 'disconnected', chainId });

  // On wallet connect, steer the wallet to the app's default source chain
  // (getDefaultWagmiChain(), derived from the default app mode) instead of
  // leaving it on whatever it connected with (e.g. Ethereum mainnet). This
  // triggers the wallet's add/switch-network prompt at connect time rather
  // than only when a bridge is initiated. Attempted once per connection so we
  // don't fight a user who deliberately switches away or rejects the prompt.
  // Safe to call getDefaultWagmiChain() here: this effect only ever runs
  // after AppConfigGate has resolved (this component mounts behind the gate).
  const hasAutoSwitched = useRef(false);
  useEffect(() => {
    if (status !== 'connected') {
      hasAutoSwitched.current = false;
      return;
    }
    if (hasAutoSwitched.current) {
      return;
    }
    hasAutoSwitched.current = true;
    const defaultChainId = getDefaultWagmiChain().id;
    if (chainId === defaultChainId) {
      return;
    }
    try {
      switchChain({ chainId: defaultChainId });
    } catch (error) {
      console.error('Failed to switch to the default network on connect', error);
    }
  }, [status, chainId, switchChain]);

  const value = useMemo<WalletContextValue>(
    () => ({
      address: address ?? '',
      status: status ?? 'disconnected',
      chainId: status === 'connected' ? chainId : undefined,
      chain: currentChain,
      walletInfo,
      walletIcon: walletInfo?.icon,
      connect: () => open({ view: 'Connect' }),
      disconnect,
      switchNetwork: (target) => {
        try {
          switchChain({ chainId: target });
        } catch (error) {
          console.error('Failed to switch chain', error);
        }
      }
    }),
    [address, chainId, currentChain, disconnect, open, status, switchChain, walletInfo]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

const LocalWalletProvider = ({ children }: { readonly children: ReactNode }) => {
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [isConnected, setIsConnected] = useState(false);
  const status = isConnected ? 'connected' : 'disconnected';
  const currentChain = useCurrentChain({ status, chainId });

  const value = useMemo<WalletContextValue>(
    () => ({
      address: isConnected ? (e2eWalletAddress ?? '') : '',
      status,
      chainId: status === 'connected' ? chainId : undefined,
      chain: currentChain,
      walletInfo: undefined,
      walletIcon: undefined,
      connect: () => setIsConnected(true),
      disconnect: () => setIsConnected(false),
      switchNetwork: (target) => {
        try {
          switchChain({ chainId: target });
        } catch (error) {
          console.error('Failed to switch chain', error);
        }
      }
    }),
    [chainId, currentChain, isConnected, status, switchChain]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
};

const WalletProvider = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(() => new QueryClient());

  // WalletProvider only ever mounts behind AppConfigGate (app/providers.tsx),
  // so getAllWagmiChains()/getDefaultWagmiChain()/getExternalLinks() are safe
  // to call unconditionally in render.
  const wagmiAdapter = useMemo(
    () =>
      new WagmiAdapter({
        ssr: true,
        projectId,
        customRpcUrls,
        networks: [...getAllWagmiChains()]
      }),
    []
  );

  // Render-phase init, not an effect -- see the comment on ensureAppKit above
  // for why. wagmiAdapter is stable across re-renders (empty deps above), so
  // this only ever runs once per mount; the module-scope appKitInitialized
  // flag guards StrictMode's double-invocation.
  useMemo(() => {
    if (IS_E2E_ENABLED) return;
    ensureAppKit({
      chains: getAllWagmiChains(),
      defaultChain: getDefaultWagmiChain(),
      externalLinks: getExternalLinks(),
      adapter: wagmiAdapter
    });
  }, [wagmiAdapter]);

  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {IS_E2E_ENABLED ? (
          <LocalWalletProvider>{children}</LocalWalletProvider>
        ) : (
          <AppKitWalletProvider>{children}</AppKitWalletProvider>
        )}
      </QueryClientProvider>
    </WagmiProvider>
  );
};

export { WalletProvider };
