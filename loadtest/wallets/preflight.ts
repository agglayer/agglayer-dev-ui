// DESIGN §4.5 — normative preflight spec. Run automatically by `run` (S11)
// and available as `pnpm loadtest preflight`.
//
// Settles this file's share of the S02 [VERIFY@S05] markers: `tracker/v1/
// health` DOES exist on this devnet (verified live: `GET
// http://127.0.0.1:8555/aggkitapi/tracker/v1/health` -> 200
// `{"status":"ok",...}`), so PREFLIGHT_TRACKER_HEALTH is implemented as a
// real hard gate, not dropped. Also implements DESIGN §10's
// `GAS_TOKEN_NOT_ETHER` non-goal note ("preflight reads gasTokenAddress()
// live on every ring chain rather than trusting the devnet's expected zero
// address") — verified live on this devnet: `gasTokenAddress()` returns
// the zero address on L1, L2A and L2B.
import type { Address } from 'viem';

import { encodeFunctionData, erc20Abi, formatUnits, parseUnits } from 'viem';

import type { LoadtestAsset, LoadtestChain, LoadtestConfig } from '../config/schema';
import type { ChainClientFactory } from './chainClients';
import type { DerivedWallet } from './derive';

import { defaultChainClientFactory } from './chainClients';
// R24 (loadtest/REVIEW.md): this file never imported `redactSecrets`/
// `redactError` at all, contradicting `redact.ts`'s own header (which
// names `preflight.ts` as an expected consumer) — every current caller
// happens to route the thrown `PreflightError` through `cli.ts`'s single
// `main().catch(redactError(...))` choke point, so nothing escaped
// unredacted TODAY, but that left the whole guarantee resting on one
// un-tested choke point rather than redacting at the source, here, like
// every other module that produces an error message.
import { redactError } from './redact';

export class PreflightError extends Error {}

export type PreflightStatus = 'pass' | 'fail' | 'skipped';

export interface PreflightFailure {
  code: string;
  message: string;
}

export interface PreflightChainRow {
  chainKey: string;
  networkId: number;
  isRingChain: boolean;
  chainIdStatus: PreflightStatus;
  bridgeBytecodeStatus: PreflightStatus;
  syncStatusStatus: PreflightStatus;
  gasStatus: PreflightStatus;
  gasTokenStatus: PreflightStatus;
}

export interface PreflightAssetRow {
  assetIndex: number;
  kind: LoadtestAsset['kind'];
  assetStatus: PreflightStatus;
  allowanceRecorded: Array<{ userId: string; allowance: string }>;
}

export interface PreflightResult {
  ok: boolean;
  chains: PreflightChainRow[];
  assets: PreflightAssetRow[];
  trackerHealthStatus: PreflightStatus;
  failures: PreflightFailure[];
  table: string;
}

export interface PreflightOptions {
  config: LoadtestConfig;
  wallets: DerivedWallet[];
  clientFactory?: ChainClientFactory;
  fetchImpl?: typeof fetch;
}

const uniqueRingChainKeys = (config: LoadtestConfig): Set<string> =>
  new Set(config.ring.slice(0, -1));

const checkChainId = async (
  clientFactory: ChainClientFactory,
  chain: LoadtestChain
): Promise<{ status: PreflightStatus; failure?: PreflightFailure }> => {
  try {
    const clients = clientFactory(chain);
    const liveChainId = await clients.public.getChainId();
    if (liveChainId !== chain.chainId) {
      return {
        status: 'fail',
        failure: {
          code: 'PREFLIGHT_CHAIN_ID',
          message: `chain "${chain.key}": rpcUrl reports chainId ${liveChainId}, config declares ${chain.chainId}`
        }
      };
    }
    return { status: 'pass' };
  } catch (error) {
    return {
      status: 'fail',
      failure: {
        code: 'PREFLIGHT_CHAIN_ID',
        message: `chain "${chain.key}": eth_chainId failed: ${redactError(error)}`
      }
    };
  }
};

const checkBridgeBytecode = async (
  clientFactory: ChainClientFactory,
  chain: LoadtestChain
): Promise<{ status: PreflightStatus; failure?: PreflightFailure }> => {
  try {
    const clients = clientFactory(chain);
    const code = await clients.public.getCode({ address: chain.bridgeAddress as Address });
    if (code === undefined || code === '0x') {
      return {
        status: 'fail',
        failure: {
          code: 'PREFLIGHT_BRIDGE_BYTECODE',
          message: `chain "${chain.key}": no bytecode at bridgeAddress ${chain.bridgeAddress}`
        }
      };
    }
    return { status: 'pass' };
  } catch (error) {
    return {
      status: 'fail',
      failure: {
        code: 'PREFLIGHT_BRIDGE_BYTECODE',
        message: `chain "${chain.key}": eth_getCode failed: ${redactError(error)}`
      }
    };
  }
};

interface SyncStatusSide {
  is_synced?: boolean;
  is_active?: boolean;
}
interface SyncStatusBody {
  l1_info?: SyncStatusSide;
  l2_info?: SyncStatusSide;
}

const checkSyncStatus = async (
  fetchImpl: typeof fetch,
  proxyUrl: string,
  chain: LoadtestChain
): Promise<{ status: PreflightStatus; failure?: PreflightFailure }> => {
  const url = `${proxyUrl}/bridge/v1/sync-status?network_id=${chain.networkId}`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return {
        status: 'fail',
        failure: {
          code: 'PREFLIGHT_SYNC_STATUS',
          message: `chain "${chain.key}" (network_id=${chain.networkId}): sync-status HTTP ${response.status} at ${url}`
        }
      };
    }
    const body = (await response.json()) as SyncStatusBody;
    const l1Ok = body.l1_info?.is_synced === true && body.l1_info?.is_active === true;
    const l2Ok = body.l2_info?.is_synced === true && body.l2_info?.is_active === true;
    if (!l1Ok || !l2Ok) {
      return {
        status: 'fail',
        failure: {
          code: 'PREFLIGHT_SYNC_STATUS',
          message: `chain "${chain.key}" (network_id=${chain.networkId}): not fully synced+active: ${JSON.stringify(body)}`
        }
      };
    }
    return { status: 'pass' };
  } catch (error) {
    return {
      status: 'fail',
      failure: {
        code: 'PREFLIGHT_SYNC_STATUS',
        message: `chain "${chain.key}" (network_id=${chain.networkId}): sync-status request failed: ${redactError(error)}`
      }
    };
  }
};

const checkTrackerHealth = async (
  fetchImpl: typeof fetch,
  proxyUrl: string
): Promise<{ status: PreflightStatus; failure?: PreflightFailure }> => {
  const url = `${proxyUrl}/tracker/v1/health`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return {
        status: 'fail',
        failure: {
          code: 'PREFLIGHT_TRACKER_HEALTH',
          message: `tracker health HTTP ${response.status} at ${url}`
        }
      };
    }
    return { status: 'pass' };
  } catch (error) {
    return {
      status: 'fail',
      failure: {
        code: 'PREFLIGHT_TRACKER_HEALTH',
        message: `tracker health request failed: ${redactError(error)}`
      }
    };
  }
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// DESIGN §10: "No `bridgeMessage`/`bridgeMessageWETH` path. A ring chain
// whose `gasTokenAddress() != 0x0` is refused ... preflight reads
// gasTokenAddress() live on every ring chain rather than trusting the
// devnet's expected zero address." A custom-gas-token chain is out of
// scope for the ring's ETH-asset support (§3), so this is a hard gate, not
// informational.
const GAS_TOKEN_ADDRESS_ABI = [
  {
    name: 'gasTokenAddress',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view'
  }
] as const;

const checkGasToken = async (
  clientFactory: ChainClientFactory,
  chain: LoadtestChain
): Promise<{ status: PreflightStatus; failure?: PreflightFailure }> => {
  try {
    const clients = clientFactory(chain);
    const data = encodeFunctionData({
      abi: GAS_TOKEN_ADDRESS_ABI,
      functionName: 'gasTokenAddress'
    });
    const { data: result } = await clients.public.call({
      to: chain.bridgeAddress as Address,
      data
    });
    if (result === undefined) {
      return {
        status: 'fail',
        failure: {
          code: 'GAS_TOKEN_NOT_ETHER',
          message: `chain "${chain.key}": gasTokenAddress() returned no data`
        }
      };
    }
    const gasTokenAddress = `0x${result.slice(-40)}`.toLowerCase();
    if (gasTokenAddress !== ZERO_ADDRESS) {
      return {
        status: 'fail',
        failure: {
          code: 'GAS_TOKEN_NOT_ETHER',
          message: `chain "${chain.key}": gasTokenAddress() is ${gasTokenAddress}, not the zero address — a custom-gas-token chain is out of scope (DESIGN §10)`
        }
      };
    }
    return { status: 'pass' };
  } catch (error) {
    return {
      status: 'fail',
      failure: {
        code: 'GAS_TOKEN_NOT_ETHER',
        message: `chain "${chain.key}": gasTokenAddress() call failed: ${redactError(error)}`
      }
    };
  }
};

const checkGas = async (
  clientFactory: ChainClientFactory,
  chain: LoadtestChain,
  targetStr: string | undefined,
  wallets: DerivedWallet[]
): Promise<{ status: PreflightStatus; failure?: PreflightFailure }> => {
  if (targetStr === undefined) return { status: 'skipped' };
  const clients = clientFactory(chain);
  const target = parseUnits(targetStr, 18);
  const failing: string[] = [];
  for (const wallet of wallets) {
    const balance = await clients.public.getBalance({ address: wallet.address });
    if (balance < target) {
      failing.push(`${wallet.userId} has ${balance.toString()} < ${target.toString()} wei`);
    }
  }
  if (failing.length > 0) {
    return {
      status: 'fail',
      failure: {
        code: 'PREFLIGHT_GAS',
        message: `chain "${chain.key}": underfunded wallet(s): ${failing.join('; ')}`
      }
    };
  }
  return { status: 'pass' };
};

// S16/A1 (VALIDATION-1.md): a single lap's `asset.amount` is not the right
// budget to check — a user funded for exactly one lap's worth of an ERC20
// runs out after its first lap and every subsequent bridge of that asset
// reverts on an arithmetic underflow (336 occurrences in the run this
// fixes: `assetTopUp` was exactly `amount × 4`, and the ring never returns
// the token until the last hop, so the 5th erc20 lap onward underflowed).
// The lap index that matters is per (user, asset) — not per user — so the
// worst case is "every lap of the whole run picks this asset": require
// `perUserBalance >= amount × ceil(load.bridgesPerMinutePerUser ×
// load.durationMinutes)`. This only tightens the ERC20 check; a plain
// "eth" asset keeps its single-lap target because its balance is folded
// into `gasPerChain` funding, which already dwarfs the bridge amount
// (DESIGN §4.2).
const requiredLaps = (
  asset: LoadtestAsset,
  load: Pick<LoadtestConfig['load'], 'bridgesPerMinutePerUser' | 'durationMinutes'>
): number =>
  asset.kind === 'erc20' ? Math.ceil(load.bridgesPerMinutePerUser * load.durationMinutes) : 1;

const checkAsset = async (
  clientFactory: ChainClientFactory,
  ringStartChain: LoadtestChain,
  asset: LoadtestAsset,
  wallets: DerivedWallet[],
  load: Pick<LoadtestConfig['load'], 'bridgesPerMinutePerUser' | 'durationMinutes'>
): Promise<{
  status: PreflightStatus;
  failure?: PreflightFailure;
  allowanceRecorded: Array<{ userId: string; allowance: string }>;
}> => {
  const clients = clientFactory(ringStartChain);
  const perLapTarget = parseUnits(asset.amount, asset.decimals);
  const worstCaseLaps = requiredLaps(asset, load);
  const target = perLapTarget * BigInt(worstCaseLaps);
  const failing: string[] = [];
  const allowanceRecorded: Array<{ userId: string; allowance: string }> = [];

  for (const wallet of wallets) {
    let balance: bigint;
    if (asset.kind === 'eth') {
      balance = await clients.public.getBalance({ address: wallet.address });
    } else {
      balance = (await clients.public.readContract({
        address: asset.address as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet.address]
      })) as bigint;
    }
    if (balance < target) {
      failing.push(`${wallet.userId} has ${balance.toString()} < ${target.toString()}`);
    }

    if (asset.kind === 'erc20') {
      try {
        const allowance = (await clients.public.readContract({
          address: asset.address as Address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [wallet.address, ringStartChain.bridgeAddress as Address]
        })) as bigint;
        allowanceRecorded.push({ userId: wallet.userId, allowance: allowance.toString() });
      } catch {
        // Informational only (DESIGN §4.5: "recorded, not asserted") — a
        // read failure here must never fail preflight.
      }
    }
  }

  if (failing.length > 0) {
    const budgetNote =
      asset.kind === 'erc20'
        ? ` — this run's worst-case budget is ${asset.amount} × ${worstCaseLaps} lap(s) = ${formatUnits(target, asset.decimals)} per user (set users.funder.assetTopUp >= ${formatUnits(target, asset.decimals)}, or fund again after raising it)`
        : '';
    return {
      status: 'fail',
      failure: {
        code: 'PREFLIGHT_ASSET',
        message: `asset[${asset.kind}] on ring[0] "${ringStartChain.key}": underfunded wallet(s)${budgetNote}: ${failing.join('; ')}`
      },
      allowanceRecorded
    };
  }
  return { status: 'pass', allowanceRecorded };
};

const renderTable = (result: Omit<PreflightResult, 'table'>): string => {
  const header = ['CHAIN', 'NET_ID', 'RING', 'CHAIN_ID', 'BRIDGE', 'SYNC', 'GAS', 'GAS_TOKEN'];
  const rows = result.chains.map((row) => [
    row.chainKey,
    String(row.networkId),
    row.isRingChain ? 'yes' : 'no',
    row.chainIdStatus,
    row.bridgeBytecodeStatus,
    row.syncStatusStatus,
    row.gasStatus,
    row.gasTokenStatus
  ]);
  const widths = header.map((head, columnIndex) =>
    Math.max(head.length, ...rows.map((row) => row[columnIndex].length))
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  const lines = [renderRow(header), ...rows.map(renderRow)];
  lines.push('');
  lines.push(`tracker/v1/health: ${result.trackerHealthStatus}`);
  result.assets.forEach((asset) => {
    lines.push(`asset[${asset.assetIndex}] (${asset.kind}): ${asset.assetStatus}`);
  });
  return lines.join('\n');
};

export const runPreflight = async (options: PreflightOptions): Promise<PreflightResult> => {
  const { config, wallets } = options;
  const clientFactory = options.clientFactory ?? defaultChainClientFactory;
  const fetchImpl = options.fetchImpl ?? fetch;

  const ringChainKeys = uniqueRingChainKeys(config);
  const funder = config.users.funder;
  const failures: PreflightFailure[] = [];

  const chains: PreflightChainRow[] = [];
  for (const chain of config.chains) {
    const isRingChain = ringChainKeys.has(chain.key);
    const chainIdResult = await checkChainId(clientFactory, chain);
    const bridgeResult = await checkBridgeBytecode(clientFactory, chain);
    const syncResult = await checkSyncStatus(fetchImpl, config.aggkitProxyUrl, chain);
    const gasResult = isRingChain
      ? await checkGas(clientFactory, chain, funder?.gasPerChain[chain.key], wallets)
      : { status: 'skipped' as PreflightStatus };
    const gasTokenResult = isRingChain
      ? await checkGasToken(clientFactory, chain)
      : { status: 'skipped' as PreflightStatus };

    [
      chainIdResult.failure,
      bridgeResult.failure,
      syncResult.failure,
      gasResult.failure,
      gasTokenResult.failure
    ]
      .filter((failure): failure is PreflightFailure => failure !== undefined)
      .forEach((failure) => failures.push(failure));

    chains.push({
      chainKey: chain.key,
      networkId: chain.networkId,
      isRingChain,
      chainIdStatus: chainIdResult.status,
      bridgeBytecodeStatus: bridgeResult.status,
      syncStatusStatus: syncResult.status,
      gasStatus: gasResult.status,
      gasTokenStatus: gasTokenResult.status
    });
  }

  const trackerHealthResult = await checkTrackerHealth(fetchImpl, config.aggkitProxyUrl);
  if (trackerHealthResult.failure) failures.push(trackerHealthResult.failure);

  const ringStartChain = config.chains.find((chain) => chain.key === config.ring[0]);
  const assets: PreflightAssetRow[] = [];
  for (let assetIndex = 0; assetIndex < config.assets.length; assetIndex += 1) {
    const asset = config.assets[assetIndex];
    if (ringStartChain === undefined) {
      assets.push({ assetIndex, kind: asset.kind, assetStatus: 'skipped', allowanceRecorded: [] });
      continue;
    }
    const assetResult = await checkAsset(
      clientFactory,
      ringStartChain,
      asset,
      wallets,
      config.load
    );
    if (assetResult.failure) failures.push(assetResult.failure);
    assets.push({
      assetIndex,
      kind: asset.kind,
      assetStatus: assetResult.status,
      allowanceRecorded: assetResult.allowanceRecorded
    });
  }

  // DESIGN §4.5's table order — the first failure in this priority order is
  // reported as the headline failure when the CLI refuses to proceed.
  const priorityOrder = [
    'PREFLIGHT_GAS',
    'PREFLIGHT_ASSET',
    'PREFLIGHT_CHAIN_ID',
    'PREFLIGHT_BRIDGE_BYTECODE',
    'PREFLIGHT_SYNC_STATUS',
    'PREFLIGHT_TRACKER_HEALTH',
    'GAS_TOKEN_NOT_ETHER'
  ];
  failures.sort((a, b) => priorityOrder.indexOf(a.code) - priorityOrder.indexOf(b.code));

  const partial: Omit<PreflightResult, 'table'> = {
    ok: failures.length === 0,
    chains,
    assets,
    trackerHealthStatus: trackerHealthResult.status,
    failures
  };

  return { ...partial, table: renderTable(partial) };
};
