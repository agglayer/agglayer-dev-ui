// DESIGN §4.2 (devnet) / §4.3 (testnet/mainnet) — normative funding spec.
// See loadtest/DESIGN.md §4 for the full rationale; this file implements it
// and settles the three [VERIFY@S05] markers (recorded back into DESIGN.md
// §4 alongside this change).
import type { Address, LocalAccount } from 'viem';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { erc20Abi, formatUnits, parseUnits } from 'viem';

import type { LoadtestAsset, LoadtestChain, LoadtestConfig } from '../config/schema';
import type { ChainClientFactory } from './chainClients';
import type { DerivedWallet } from './derive';

import { ChainNonceManager, defaultChainClientFactory } from './chainClients';
import { deriveFunderAccount } from './derive';
import { redactSecrets } from './redact';
import { resolveSecret } from './secrets';

export class FundingError extends Error {}

export type FundLogger = (message: string) => void;

export interface ChainFundingSummary {
  chainKey: string;
  usersConsidered: number;
  usersFunded: number;
  usersSkippedAlreadyFunded: number;
}

export interface AssetFundingSummary {
  assetIndex: number;
  kind: LoadtestAsset['kind'];
  usersConsidered: number;
  usersFunded: number;
  usersSkippedAlreadyFunded: number;
  note?: string;
}

export interface FundResult {
  env: LoadtestConfig['env'];
  strategy: 'anvil_setBalance' | 'transfer';
  perChain: ChainFundingSummary[];
  perAsset: AssetFundingSummary[];
  erc20FallbackAddress?: Address;
  durationMs: number;
}

export interface FundOptions {
  config: LoadtestConfig;
  wallets: DerivedWallet[];
  logger?: FundLogger;
  clientFactory?: ChainClientFactory;
  /** DESIGN §4.3 rule 5 — required (and asserted true) when config.env === 'mainnet'. */
  mainnetConfirmed?: boolean;
}

// Exact decimal multiplication on the string form (assets[].amount is a
// schema-validated `/^\d+(\.\d+)?$/` decimal string) by an integer factor —
// never via `Number(...)`, which would introduce float error for a value
// that is about to be parsed back into a bigint via `parseUnits`.
export const decimalTimesN = (decimalString: string, n: bigint): string => {
  const [integerPart, fractionPart = ''] = decimalString.split('.');
  const scale = fractionPart.length;
  const scaledDigits = `${integerPart}${fractionPart}`;
  const scaledValue = (BigInt(scaledDigits) * n).toString().padStart(scale + 1, '0');
  if (scale === 0) return scaledValue;
  const splitAt = scaledValue.length - scale;
  return `${scaledValue.slice(0, splitAt)}.${scaledValue.slice(splitAt)}`;
};

// Retained for `decimalTimesN`'s original callers/tests — no longer used as
// the ERC20 top-up default (see `defaultAssetTopUp` below; VALIDATION-1.md
// A1: a flat ×4 default sized every user for exactly 4 bridges regardless
// of run length, so the 5th+ erc20 lap underflowed for any run longer than
// that).
export const decimalTimesFour = (decimalString: string): string =>
  decimalTimesN(decimalString, BigInt(4));

// DESIGN §2.1's ERC20 `assetTopUp` default (S16/A1, superseding the old
// flat ×4 default): duration-derived, sized for the worst case where every
// lap of the whole run picks this asset — `ceil(bridgesPerMinutePerUser ×
// durationMinutes)` laps — plus a `maxInflightLapsPerUser`-sized margin so
// laps still in flight when the load phase ends (and draining afterwards,
// `runner.ts`'s `lapsInFlightAtStop`) don't underflow the ring's last leg.
// `users.funder.assetTopUp` remains a fully explicit override; this is only
// the value used when it is omitted.
export const defaultAssetTopUp = (
  amount: string,
  load: Pick<
    LoadtestConfig['load'],
    'bridgesPerMinutePerUser' | 'durationMinutes' | 'maxInflightLapsPerUser'
  >
): string => {
  const worstCaseLaps = Math.ceil(load.bridgesPerMinutePerUser * load.durationMinutes);
  const factor = BigInt(worstCaseLaps + load.maxInflightLapsPerUser);
  return decimalTimesN(amount, factor);
};

const uniqueRingChainKeys = (config: LoadtestConfig): string[] =>
  Array.from(new Set(config.ring.slice(0, -1)));

// ---------------------------------------------------------------------------
// Devnet ERC20 fallback: reuses tests/e2e/globalSetup.ts's dockerized-forge
// deploy pattern (same minimal E2EToken contract, same foundry image) for
// the case DESIGN §4.2 calls out: "If erc20_address turns out unusable (no
// bytecode / zero funder balance), S05 falls back to the existing
// dockerized-forge deploy path ... and records the new address in the
// generated config." Not exercised by the S05 acceptance run against this
// devnet (its erc20_address IS usable — verified live), but implemented so
// an enclave recreation (which rotates erc20_address, per
// tests/e2e/globalSetup.ts's own comment) doesn't hard-fail `fund`.
// ---------------------------------------------------------------------------

const E2E_TOKEN_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract E2EToken {
    string public name = "Agglayer E2E Token";
    string public symbol = "E2E";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
`;

const DOCKER_FOUNDRY_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const FALLBACK_INITIAL_SUPPLY = '1000000000000000000000';

const deployFallbackErc20 = (rpcUrl: string, funderPrivateKey: string): Address => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadtest-erc20-'));
  try {
    fs.writeFileSync(
      path.join(workDir, 'foundry.toml'),
      '[profile.default]\nsrc = "src"\nout = "out"\n'
    );
    fs.mkdirSync(path.join(workDir, 'src'));
    fs.writeFileSync(path.join(workDir, 'src', 'E2EToken.sol'), E2E_TOKEN_SOURCE);

    const forgeCmd =
      `cd /workspace && forge create src/E2EToken.sol:E2EToken ` +
      `--rpc-url ${rpcUrl} --private-key ${funderPrivateKey} --broadcast ` +
      `--constructor-args ${FALLBACK_INITIAL_SUPPLY}`;

    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const output = execFileSync(
      'sudo',
      [
        'docker',
        'run',
        '--rm',
        '--network',
        'host',
        '--user',
        `${uid}:${gid}`,
        '-e',
        'HOME=/workspace',
        '-v',
        `${workDir}:/workspace`,
        DOCKER_FOUNDRY_IMAGE,
        forgeCmd
      ],
      { encoding: 'utf8' }
    );
    const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
    if (!match) {
      throw new FundingError(
        `fund: fallback ERC20 deploy did not report a deployed address (forge output unparseable)`
      );
    }
    return match[1] as Address;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Devnet path (DESIGN §4.2)
// ---------------------------------------------------------------------------

interface DevnetFundArgs {
  config: LoadtestConfig;
  wallets: DerivedWallet[];
  logger: FundLogger;
  clientFactory: ChainClientFactory;
}

const fundDevnetGas = async ({
  config,
  wallets,
  logger,
  clientFactory,
  chainByKey
}: DevnetFundArgs & { chainByKey: Map<string, LoadtestChain> }): Promise<ChainFundingSummary[]> => {
  const funder = config.users.funder;
  if (funder === undefined) {
    throw new FundingError(
      'FUNDER_REQUIRED_FOR_DEVNET_FUNDING: users.funder must be set (it carries gasPerChain targets and the ERC20 sender key) even when devnetFunding is anvil_setBalance'
    );
  }

  const perChain: ChainFundingSummary[] = [];
  for (const chainKey of uniqueRingChainKeys(config)) {
    const chain = chainByKey.get(chainKey);
    if (chain === undefined) continue;
    const targetStr = funder.gasPerChain[chainKey];
    if (targetStr === undefined) continue;
    const target = parseUnits(targetStr, 18);
    const clients = clientFactory(chain);

    let funded = 0;
    let skipped = 0;
    // anvil_setBalance is a state SET, not a send — no nonce contention, so
    // every wallet on a chain can be funded concurrently (this is what
    // keeps `fund --users 20` well under the 60s target).
    await Promise.all(
      wallets.map(async (wallet) => {
        const current = await clients.public.getBalance({ address: wallet.address });
        // anvil_setBalance SETS, it does not add — never lower a wallet.
        if (current >= target) {
          skipped += 1;
          return;
        }
        await clients.test.setBalance({ address: wallet.address, value: target });
        funded += 1;
      })
    );

    logger(`gas[${chainKey}]: funded ${funded}, already-funded ${skipped} (target ${targetStr})`);
    perChain.push({
      chainKey,
      usersConsidered: wallets.length,
      usersFunded: funded,
      usersSkippedAlreadyFunded: skipped
    });
  }
  return perChain;
};

const isErc20Usable = async (
  clientFactory: ChainClientFactory,
  chain: LoadtestChain,
  address: Address,
  holder: Address
): Promise<boolean> => {
  const clients = clientFactory(chain);
  const bytecode = await clients.public.getCode({ address }).catch(() => undefined);
  if (bytecode === undefined || bytecode === '0x') return false;
  const balance = await clients.public
    .readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })
    .catch(() => BigInt(0));
  return balance > BigInt(0);
};

const fundDevnetErc20 = async ({
  config,
  wallets,
  logger,
  clientFactory,
  chainByKey
}: DevnetFundArgs & { chainByKey: Map<string, LoadtestChain> }): Promise<{
  perAsset: AssetFundingSummary[];
  erc20FallbackAddress?: Address;
}> => {
  const funder = config.users.funder;
  if (funder === undefined) {
    throw new FundingError('FUNDER_REQUIRED_FOR_DEVNET_FUNDING: users.funder is not configured');
  }

  const perAsset: AssetFundingSummary[] = [];

  // DESIGN §4.3's assetTopUp language is specific to ERC20 assets ("assetTopUp
  // of each ERC20 asset"); a plain "eth" asset needs no separate top-up on
  // devnet because gasPerChain[ring[0]] already funds the wallet's native
  // balance far beyond the tiny ETH bridge amount it will send — folding a
  // second, separate native top-up in here would just be a second
  // anvil_setBalance call racing/overwriting the first (setBalance SETS, it
  // does not add).
  let erc20FallbackAddress: Address | undefined;

  for (let assetIndex = 0; assetIndex < config.assets.length; assetIndex += 1) {
    const asset = config.assets[assetIndex];
    if (asset.kind !== 'erc20') {
      perAsset.push({
        assetIndex,
        kind: 'eth',
        usersConsidered: wallets.length,
        usersFunded: 0,
        usersSkippedAlreadyFunded: wallets.length,
        note: 'native ETH asset top-up is folded into gasPerChain funding on ring[0], not sent separately'
      });
      continue;
    }

    const ringStartKey = config.ring[0];
    const ringStartChain = chainByKey.get(ringStartKey);
    if (ringStartChain === undefined) {
      throw new FundingError(`fund: ring[0] "${ringStartKey}" is not present in chains`);
    }

    const senderAccount = deriveFunderAccount(config);
    let effectiveAddress = asset.address as Address;

    if (
      !(await isErc20Usable(clientFactory, ringStartChain, effectiveAddress, senderAccount.address))
    ) {
      logger(
        `erc20[${assetIndex}]: configured address ${effectiveAddress} has no bytecode or zero funder balance on "${ringStartKey}" — deploying a fresh fallback ERC20 (DESIGN §4.2 fallback path)`
      );
      // deployFallbackErc20 needs the raw private key (forge --private-key),
      // not the derived account — resolved via the same secretRef the
      // account came from, and never passed to `logger`.
      const rawKey = resolveSecret(funder.privateKeyRef, 'users.funder.privateKeyRef');
      effectiveAddress = deployFallbackErc20(ringStartChain.rpcUrl, rawKey);
      erc20FallbackAddress = effectiveAddress;
      logger(`erc20[${assetIndex}]: fallback deployed at ${effectiveAddress}`);
    }

    const clients = clientFactory(ringStartChain);
    const walletClient = clients.wallet(senderAccount);
    const nonceManager = new ChainNonceManager(clients.public, senderAccount.address);

    const topUpStr = funder.assetTopUp ?? defaultAssetTopUp(asset.amount, config.load);
    const topUp = parseUnits(topUpStr, asset.decimals);

    let funded = 0;
    let skipped = 0;
    for (const wallet of wallets) {
      const current = (await clients.public.readContract({
        address: effectiveAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet.address]
      })) as bigint;
      if (current >= topUp) {
        skipped += 1;
        continue;
      }
      const needed = topUp - current;
      const nonce = await nonceManager.nextNonce();
      try {
        await walletClient.writeContract({
          address: effectiveAddress,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [wallet.address, needed],
          nonce
        });
        funded += 1;
      } catch (error) {
        nonceManager.onSendError();
        throw new FundingError(
          `erc20[${assetIndex}]: transfer to ${wallet.userId} failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`
        );
      }
    }

    logger(
      `erc20[${assetIndex}]: funded ${funded}, already-funded ${skipped} (target ${topUpStr})`
    );
    perAsset.push({
      assetIndex,
      kind: 'erc20',
      usersConsidered: wallets.length,
      usersFunded: funded,
      usersSkippedAlreadyFunded: skipped
    });
  }

  return { perAsset, erc20FallbackAddress };
};

const fundDevnet = async (args: DevnetFundArgs): Promise<Omit<FundResult, 'durationMs'>> => {
  const chainByKey = new Map(args.config.chains.map((chain) => [chain.key, chain]));
  const perChain = await fundDevnetGas({ ...args, chainByKey });
  const { perAsset, erc20FallbackAddress } = await fundDevnetErc20({ ...args, chainByKey });
  return {
    env: args.config.env,
    strategy: 'anvil_setBalance',
    perChain,
    perAsset,
    ...(erc20FallbackAddress !== undefined ? { erc20FallbackAddress } : {})
  };
};

// ---------------------------------------------------------------------------
// Testnet / mainnet path (DESIGN §4.3)
// ---------------------------------------------------------------------------

interface TransferFundArgs {
  config: LoadtestConfig;
  wallets: DerivedWallet[];
  logger: FundLogger;
  clientFactory: ChainClientFactory;
  mainnetConfirmed?: boolean;
}

const fundViaTransfer = async ({
  config,
  wallets,
  logger,
  clientFactory,
  mainnetConfirmed
}: TransferFundArgs): Promise<Omit<FundResult, 'durationMs'>> => {
  if (config.env === 'mainnet' && mainnetConfirmed !== true) {
    throw new FundingError(
      'MAINNET_CONFIRMATION_REQUIRED: fund refuses to run against env "mainnet" without --i-know-this-is-mainnet'
    );
  }

  const funder = config.users.funder;
  if (funder === undefined) {
    throw new FundingError('FUNDER_REQUIRED: users.funder must be set for testnet/mainnet funding');
  }

  const senderAccount: LocalAccount = deriveFunderAccount(config);
  const chainByKey = new Map(config.chains.map((chain) => [chain.key, chain]));
  const ringKeys = uniqueRingChainKeys(config);
  const clientsByChain = new Map(
    ringKeys.map((key) => {
      const chain = chainByKey.get(key);
      if (chain === undefined)
        throw new FundingError(`fund: ring chain "${key}" is not present in chains`);
      return [key, clientFactory(chain)] as const;
    })
  );

  // --- Pass 1: plan the native outlay per chain and enforce the cap
  //     BEFORE sending anything (DESIGN §4.3 rule 1: "over cap => refuse
  //     the whole fund, sending nothing"). --------------------------------
  const neededPerChain = new Map<string, Map<string, bigint>>();
  for (const chainKey of ringKeys) {
    const targetStr = funder.gasPerChain[chainKey];
    if (targetStr === undefined) continue;
    const target = parseUnits(targetStr, 18);
    const clients = clientsByChain.get(chainKey)!;

    const perUser = new Map<string, bigint>();
    let total = BigInt(0);
    for (const wallet of wallets) {
      const current = await clients.public.getBalance({ address: wallet.address });
      const needed = current >= target ? BigInt(0) : target - current;
      perUser.set(wallet.userId, needed);
      total += needed;
    }
    neededPerChain.set(chainKey, perUser);

    const capStr = funder.maxTotalSpend[chainKey];
    const cap = parseUnits(capStr ?? '0', 18);
    if (total > cap) {
      throw new FundingError(
        `FUNDING_CAP_EXCEEDED: planned native outlay on "${chainKey}" (${formatUnits(total, 18)}) exceeds users.funder.maxTotalSpend (${capStr ?? '0'}) — refusing to send anything`
      );
    }
  }

  // --- Pass 2: send, one serialized nonce queue per chain (DESIGN §4.4). --
  // R32/R27 (loadtest/REVIEW.md): this used to re-check the cap
  // incrementally here too ("protects against the plan being stale by the
  // time sending finishes"), but that check was confirmed DEAD CODE — Pass
  // 1 above sums `neededPerChain` across the exact same wallets in the
  // exact same order, so by the time this loop reaches wallet `i`,
  // `spent + needed` can never exceed `cap` (Pass 1 already refused the
  // whole fund otherwise). Deleted rather than kept as defensive-but-
  // unreachable code; `cap` is no longer read in this loop, only `spent`
  // for the summary log line below.
  const perChain: ChainFundingSummary[] = [];
  for (const chainKey of ringKeys) {
    const perUserNeeded = neededPerChain.get(chainKey);
    if (perUserNeeded === undefined) continue;
    const clients = clientsByChain.get(chainKey)!;
    const walletClient = clients.wallet(senderAccount);
    const nonceManager = new ChainNonceManager(clients.public, senderAccount.address);

    let spent = BigInt(0);
    let funded = 0;
    let skipped = 0;
    for (const wallet of wallets) {
      const needed = perUserNeeded.get(wallet.userId) ?? BigInt(0);
      if (needed === BigInt(0)) {
        skipped += 1;
        continue;
      }
      const nonce = await nonceManager.nextNonce();
      try {
        await walletClient.sendTransaction({ to: wallet.address, value: needed, nonce });
        spent += needed;
        funded += 1;
      } catch (error) {
        nonceManager.onSendError();
        throw new FundingError(
          `native funding send to "${wallet.userId}" on "${chainKey}" failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`
        );
      }
    }
    logger(
      `gas[${chainKey}]: funded ${funded}, already-funded ${skipped}, spent ${formatUnits(spent, 18)}`
    );
    perChain.push({
      chainKey,
      usersConsidered: wallets.length,
      usersFunded: funded,
      usersSkippedAlreadyFunded: skipped
    });
  }

  // --- ERC20 asset top-ups on ring[0] (not counted against
  //     maxTotalSpend, which is denominated in the chain's native
  //     currency — see the module-level note in fundDevnetErc20 for why an
  //     "eth" asset needs no separate step here either). ------------------
  //
  // R19 (loadtest/REVIEW.md): unlike the native path above, this used to
  // have NO cap at all — the schema now requires `maxTotalErc20Spend`
  // whenever a non-devnet-anvil fund uses an erc20 asset
  // (`FUNDER_MAX_ERC20_SPEND_REQUIRED`), and it is enforced here the same
  // way the native path enforces `maxTotalSpend`: planned first (refuse the
  // whole erc20 fund, sending nothing, if the total exceeds the cap), then
  // sent. Unlike the native path's Pass 2 (R32: its incremental re-check is
  // provably unreachable dead code, since Pass 1 sums the exact same
  // wallets in the exact same order), this does NOT repeat that mistake —
  // one plan-then-send pass, no redundant incremental check.
  const perAsset: AssetFundingSummary[] = [];
  const ringStartKey = config.ring[0];
  const ringStartChain = chainByKey.get(ringStartKey);

  for (let assetIndex = 0; assetIndex < config.assets.length; assetIndex += 1) {
    const asset = config.assets[assetIndex];
    if (asset.kind !== 'erc20' || ringStartChain === undefined) {
      perAsset.push({
        assetIndex,
        kind: asset.kind,
        usersConsidered: wallets.length,
        usersFunded: 0,
        usersSkippedAlreadyFunded: wallets.length,
        note:
          asset.kind === 'eth'
            ? 'native ETH asset top-up is folded into gasPerChain funding on ring[0], not sent separately'
            : undefined
      });
      continue;
    }

    const ringStartClients = clientsByChain.get(ringStartKey) ?? clientFactory(ringStartChain);
    const walletClient = ringStartClients.wallet(senderAccount);
    const nonceManager = new ChainNonceManager(ringStartClients.public, senderAccount.address);
    const topUpStr = funder.assetTopUp ?? defaultAssetTopUp(asset.amount, config.load);
    const topUp = parseUnits(topUpStr, asset.decimals);

    // --- Plan: compute every wallet's shortfall and the total BEFORE
    //     sending anything, and refuse the whole erc20 fund if the total
    //     exceeds the cap (schema requires the cap to be set here; the
    //     devnet anvil-mint path is the only uncapped one, by design). ----
    const erc20NeededPerWallet = new Map<string, bigint>();
    let erc20Total = BigInt(0);
    for (const wallet of wallets) {
      const current = (await ringStartClients.public.readContract({
        address: asset.address as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet.address]
      })) as bigint;
      const needed = current >= topUp ? BigInt(0) : topUp - current;
      erc20NeededPerWallet.set(wallet.userId, needed);
      erc20Total += needed;
    }
    if (funder.maxTotalErc20Spend !== undefined) {
      const erc20Cap = parseUnits(funder.maxTotalErc20Spend, asset.decimals);
      if (erc20Total > erc20Cap) {
        throw new FundingError(
          `FUNDING_CAP_EXCEEDED: planned erc20[${assetIndex}] outlay (${formatUnits(erc20Total, asset.decimals)}) exceeds users.funder.maxTotalErc20Spend (${funder.maxTotalErc20Spend}) — refusing to send anything`
        );
      }
    }

    let funded = 0;
    let skipped = 0;
    for (const wallet of wallets) {
      const needed = erc20NeededPerWallet.get(wallet.userId) ?? BigInt(0);
      if (needed === BigInt(0)) {
        skipped += 1;
        continue;
      }
      const nonce = await nonceManager.nextNonce();
      try {
        await walletClient.writeContract({
          address: asset.address as Address,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [wallet.address, needed],
          nonce
        });
        funded += 1;
      } catch (error) {
        nonceManager.onSendError();
        throw new FundingError(
          `erc20[${assetIndex}]: transfer to ${wallet.userId} failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`
        );
      }
    }
    logger(
      `erc20[${assetIndex}]: funded ${funded}, already-funded ${skipped} (target ${topUpStr})`
    );
    perAsset.push({
      assetIndex,
      kind: 'erc20',
      usersConsidered: wallets.length,
      usersFunded: funded,
      usersSkippedAlreadyFunded: skipped
    });
  }

  return { env: config.env, strategy: 'transfer', perChain, perAsset };
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const fundWallets = async (options: FundOptions): Promise<FundResult> => {
  const start = Date.now();
  const logger = options.logger ?? (() => {});
  const clientFactory = options.clientFactory ?? defaultChainClientFactory;
  const { config, wallets } = options;

  const effectiveDevnetFunding = config.users.devnetFunding ?? 'anvil_setBalance';
  const useAnvilSetBalance =
    config.env === 'devnet' && effectiveDevnetFunding === 'anvil_setBalance';

  const result = useAnvilSetBalance
    ? await fundDevnet({ config, wallets, logger, clientFactory })
    : await fundViaTransfer({
        config,
        wallets,
        logger,
        clientFactory,
        mainnetConfirmed: options.mainnetConfirmed
      });

  return { ...result, durationMs: Date.now() - start };
};
