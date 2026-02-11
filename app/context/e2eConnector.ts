import {
  RpcRequestError,
  createWalletClient,
  fromHex,
  http as viemHttp,
  isAddress,
  isHex,
  numberToHex,
  type Address,
  type EIP1193EventMap,
  type EIP1193Provider,
  type EIP1193RequestFn,
  type Hex,
  type SendTransactionRequest,
  type WalletRpcSchema,
} from 'viem';
import type { privateKeyToAccount } from 'viem/accounts';
import { rpc } from 'viem/utils';
import { ChainNotConfiguredError, createConnector } from 'wagmi';

type E2EConnectorParams = {
  account: ReturnType<typeof privateKeyToAccount>;
  resolveRpcUrl: (chainId: number) => string;
};

type ParsedTransaction = Pick<SendTransactionRequest, 'to' | 'data' | 'value' | 'gas' | 'nonce'>;

type ConnectParameters<withCapabilities extends boolean> = {
  chainId?: number;
  isReconnecting?: boolean;
  withCapabilities?: withCapabilities | boolean;
};

type CapabilitiesAccount = {
  address: Address;
  capabilities: Record<string, unknown>;
};

type ConnectAccounts<withCapabilities extends boolean> = withCapabilities extends true
  ? readonly CapabilitiesAccount[]
  : readonly Address[];

type ProviderEventName = keyof EIP1193EventMap;
type ProviderListeners = {
  [event in ProviderEventName]: Set<EIP1193EventMap[event]>;
};

const RPC_METHODS = {
  CHAIN_ID: 'eth_chainId',
  ACCOUNTS: 'eth_accounts',
  REQUEST_ACCOUNTS: 'eth_requestAccounts',
  SEND_TRANSACTION: 'eth_sendTransaction',
  SWITCH_ETHEREUM_CHAIN: 'wallet_switchEthereumChain',
} as const;

const CONNECTOR_METADATA = {
  id: 'e2e-private-key',
  name: 'E2E Private Key',
  type: 'e2e-private-key',
} as const;

const CONNECTOR_ERRORS = {
  INVALID_TX_PARAMS: 'E2E_WALLET_INVALID_TX_PARAMS',
  INVALID_SWITCH_PARAMS: 'E2E_WALLET_INVALID_SWITCH_PARAMS',
} as const;

const parseHex = (value: unknown): Hex | null => (isHex(value) ? (value as Hex) : null);

const parseAddress = (value: unknown): Address | undefined => {
  if (typeof value !== 'string') return undefined;
  return isAddress(value) ? value : undefined;
};

const parseBigIntHex = (value: unknown): bigint | undefined => {
  const hexValue = parseHex(value);
  if (!hexValue) return undefined;

  return fromHex(hexValue, 'bigint');
};

const parseNonceHex = (value: unknown): number | undefined => {
  const hexValue = parseHex(value);
  if (!hexValue) return undefined;

  return fromHex(hexValue, 'number');
};

const parseSendTransaction = (params: unknown): ParsedTransaction | null => {
  if (!Array.isArray(params)) return null;
  const [first] = params;
  if (typeof first !== 'object' || first === null) return null;

  const tx = first as Record<string, unknown>;

  return {
    to: parseAddress(tx.to),
    data: parseHex(tx.data) ?? undefined,
    value: parseBigIntHex(tx.value),
    gas: parseBigIntHex(tx.gas),
    nonce: parseNonceHex(tx.nonce),
  };
};

const parseSwitchChainId = (params: unknown): number | null => {
  if (!Array.isArray(params)) return null;
  const [first] = params;
  if (typeof first !== 'object' || first === null) return null;

  const payload = first as Record<string, unknown>;
  const chainIdHex = parseHex(payload.chainId);
  if (!chainIdHex) return null;

  try {
    return fromHex(chainIdHex, 'number');
  } catch {
    return null;
  }
};

const parseChainId = (value: string): number | null => {
  if (value.startsWith('0x')) {
    try {
      return fromHex(value as Hex, 'number');
    } catch {
      return null;
    }
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const createProviderListeners = (): ProviderListeners => ({
  accountsChanged: new Set(),
  chainChanged: new Set(),
  connect: new Set(),
  disconnect: new Set(),
  message: new Set(),
});

const resolveConnectAccounts = <withCapabilities extends boolean>({
  address,
  withCapabilities,
}: {
  address: Address;
  withCapabilities: withCapabilities | boolean | undefined;
}): ConnectAccounts<withCapabilities> => {
  if (withCapabilities) {
    const accounts: readonly CapabilitiesAccount[] = [{ address, capabilities: {} }];
    return accounts as ConnectAccounts<withCapabilities>;
  }

  const accounts: readonly Address[] = [address];
  return accounts as ConnectAccounts<withCapabilities>;
};

export const buildE2EPrivateKeyConnector = ({ account, resolveRpcUrl }: E2EConnectorParams) =>
  createConnector<EIP1193Provider>((config) => {
    let isConnected = false;
    let activeChainId = config.chains[0].id;
    const providerListeners = createProviderListeners();

    const getChain = (chainId: number) => {
      const chain = config.chains.find((item) => item.id === chainId);
      if (!chain) throw new ChainNotConfiguredError();
      return chain;
    };

    const emitChainChanged = (chainId: number) => {
      const chainIdHex = numberToHex(chainId);
      for (const listener of providerListeners.chainChanged) {
        listener(chainIdHex);
      }
      config.emitter.emit('change', { chainId });
    };

    const emitAccountsChanged = () => {
      const accounts: readonly Address[] = [account.address];
      for (const listener of providerListeners.accountsChanged) {
        listener([...accounts]);
      }
      config.emitter.emit('change', { accounts });
    };

    const switchToChain = (chainId: number) => {
      getChain(chainId);
      activeChainId = chainId;
      emitChainChanged(chainId);
    };

    const handleSendTransactionRequest = async (params: unknown) => {
      const tx = parseSendTransaction(params);
      if (!tx) {
        throw new Error(CONNECTOR_ERRORS.INVALID_TX_PARAMS);
      }

      const walletClient = createWalletClient({
        account,
        chain: getChain(activeChainId),
        transport: viemHttp(resolveRpcUrl(activeChainId)),
      });

      return walletClient.sendTransaction({
        account,
        chain: getChain(activeChainId),
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: tx.gas,
        nonce: tx.nonce,
      });
    };

    const handleSwitchChainRequest = (params: unknown): null => {
      const targetChainId = parseSwitchChainId(params);
      if (!targetChainId) {
        throw new Error(CONNECTOR_ERRORS.INVALID_SWITCH_PARAMS);
      }

      switchToChain(targetChainId);
      return null;
    };

    const forwardRpcRequest = async (method: string, params: unknown) => {
      const rpcUrl = resolveRpcUrl(activeChainId);
      const body = { method, params };
      const { error, result } = await rpc.http(rpcUrl, { body });
      if (error) throw new RpcRequestError({ body, error, url: rpcUrl });
      return result;
    };

    const handleProviderRequest: EIP1193RequestFn<WalletRpcSchema> = async ({ method, params }) => {
      if (method === RPC_METHODS.CHAIN_ID) return numberToHex(activeChainId);
      if (method === RPC_METHODS.ACCOUNTS || method === RPC_METHODS.REQUEST_ACCOUNTS) return [account.address];
      if (method === RPC_METHODS.SWITCH_ETHEREUM_CHAIN) return handleSwitchChainRequest(params);
      if (method === RPC_METHODS.SEND_TRANSACTION) return handleSendTransactionRequest(params);

      return forwardRpcRequest(method, params);
    };

    const switchChain = async ({ chainId }: { chainId: number }) => {
      const chain = getChain(chainId);
      switchToChain(chainId);
      return chain;
    };

    const onDisconnect = async () => {
      isConnected = false;
      config.emitter.emit('disconnect');
    };

    return {
      ...CONNECTOR_METADATA,
      async connect<withCapabilities extends boolean = false>(parameters: ConnectParameters<withCapabilities> = {}) {
        const { chainId, withCapabilities } = parameters;

        if (chainId && chainId !== activeChainId) {
          await switchChain({ chainId });
        }

        isConnected = true;
        emitAccountsChanged();

        return {
          accounts: resolveConnectAccounts({ address: account.address, withCapabilities }),
          chainId: activeChainId,
        };
      },
      async disconnect() {
        isConnected = false;
        config.emitter.emit('disconnect');
      },
      async getAccounts() {
        if (!isConnected) throw new Error('Connector not connected');
        return [account.address];
      },
      async getChainId() {
        return activeChainId;
      },
      async getProvider() {
        return {
          request: handleProviderRequest,
          on(event, listener) {
            providerListeners[event].add(listener);
          },
          removeListener(event, listener) {
            providerListeners[event].delete(listener);
          },
        };
      },
      async isAuthorized() {
        return isConnected;
      },
      switchChain,
      onAccountsChanged(accounts) {
        if (accounts.length === 0) {
          void onDisconnect();
          return;
        }

        const parsed = accounts.map((value) => parseAddress(value)).filter((value): value is Address => Boolean(value));
        if (parsed.length > 0) {
          config.emitter.emit('change', { accounts: parsed });
        }
      },
      onChainChanged(chainId) {
        const parsedChainId = parseChainId(chainId);
        if (parsedChainId === null) return;

        activeChainId = parsedChainId;
        config.emitter.emit('change', { chainId: parsedChainId });
      },
      onDisconnect,
    };
  });
