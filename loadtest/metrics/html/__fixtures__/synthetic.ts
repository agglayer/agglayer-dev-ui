// Test-only generator for large synthetic runs (not a `*.test.ts`, so vitest does
// not collect it). Builds a results.json object and an activity.ndjson text for
// `wallets` wallets over `hours` hours with the optional heavy-load blocks (pump,
// wallet balances, L1 leaves, HTTP windows), deterministically. Every host,
// address and hash is made up.
import fs from 'node:fs';
import path from 'node:path';

import type { ResultsJson } from '../../report';

export interface SyntheticOptions {
  wallets: number;
  hours: number;
  pump?: boolean;
  /** Minutes between lap starts of one wallet. */
  lapEveryMin?: number;
  seed?: number;
  /** A hostile or secret-looking string put into an error sample / abort cause. */
  errorSample?: string;
  /** Extra config merged over the base (for redaction tests). */
  configOverride?: Record<string, unknown>;
  /** Free-text `hop_end` outcome for one failed hop at the end (timeout_ready_to_claim). */
  failOne?: boolean;
}

export interface SyntheticRun {
  results: ResultsJson;
  ndjson: string;
  startMs: number;
}

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const ROUTES = ['BALI_82->BALI_85', 'BALI_85->BALI_82'];

export const buildSyntheticRun = (o: SyntheticOptions): SyntheticRun => {
  const rnd = mulberry32(o.seed ?? 1);
  const startMs = Date.UTC(2026, 9, 14, 9, 0, 0);
  const durationMs = o.hours * 3_600_000;
  const lapEvery = (o.lapEveryMin ?? 20) * 60_000;
  const lines: string[] = [];
  const emit = (
    ts: number,
    kind: string,
    userId: string | null,
    extra: Record<string, unknown> = {}
  ): void => {
    lines.push(
      JSON.stringify({
        ts: new Date(ts).toISOString(),
        kind,
        userId,
        mode: userId === null ? null : 'headless',
        ...extra
      })
    );
  };
  emit(startMs, 'run_start', null, {
    toolVersion: 'synthetic',
    sdkVersion: 'synthetic',
    host: { cores: 8, totalMemMb: 16000, platform: 'linux' }
  });

  const hops: Record<string, unknown>[] = [];
  const byRoute: Record<string, number> = { [ROUTES[0]]: 0, [ROUTES[1]]: 0 };
  let laps = 0;
  let failed = 0;
  let ticks = 0;
  for (let w = 0; w < o.wallets; w += 1) {
    const userId = `u${w}`;
    for (let t = w * 7000; t < durationMs - 40 * 60_000; t += lapEvery) {
      const lapStart = startMs + t;
      const lapId = `${userId}:a0:l${laps}`;
      emit(lapStart, 'tick', userId);
      ticks += 1;
      let cursor = lapStart;
      let lapOk = true;
      for (let h = 0; h < 2; h += 1) {
        const hopId = `${lapId}:h${h}`;
        const ready = (h === 0 ? 11 : 21) * 60_000 + (rnd() - 0.5) * 6 * 60_000;
        const states: [string, number][] = [
          ['BRIDGE_BUILD', 0],
          ['BRIDGE_PENDING', 200],
          ['AWAITING_ACTIVITY', 4200],
          ['AWAITING_READY', 12_000],
          ['CLAIM_BUILD', 12_000 + ready],
          ['CLAIM_PENDING', 12_300 + ready],
          ['AWAITING_CLAIMED', 16_500 + ready]
        ];
        const failThis = o.failOne === true && w === 0 && laps === 0 && h === 1;
        emit(cursor, 'hop_state', userId, {
          hopId,
          lapId,
          from: 'PLANNED',
          to: 'BRIDGE_BUILD',
          transition: 'T2'
        });
        let prev = 'BRIDGE_BUILD';
        for (const [to, at] of states.slice(1)) {
          if (failThis && to === 'CLAIM_BUILD') break;
          emit(cursor + at, 'hop_state', userId, {
            hopId,
            lapId,
            from: prev,
            to,
            transition: 'T9'
          });
          prev = to;
        }
        const end = cursor + (failThis ? 3_600_000 : 16_500 + ready + 25_000);
        const outcome = failThis ? 'timeout_ready_to_claim' : 'hop_completed_manual';
        emit(end, 'hop_end', userId, { hopId, lapId, hopRoute: ROUTES[h], outcome });
        byRoute[ROUTES[h]] += 1;
        if (failThis) {
          lapOk = false;
        } else {
          hops.push({
            hopId,
            lapId,
            userId,
            mode: 'headless',
            hopRoute: ROUTES[h],
            fromNetworkId: h === 0 ? 82 : 85,
            toNetworkId: h === 0 ? 85 : 82,
            assetKind: 'erc20',
            assetIndex: 1,
            outcome,
            depositCount: laps,
            bridge: {
              txHash: '0xfaketx',
              blockNumber: '1',
              minedObservedAt: cursor + 4200,
              gas: { blockNumber: '1', gasUsed: '100000', effectiveGasPrice: '1000251' }
            },
            stages: {
              l1InfoTreeIndexAt: cursor + 4200 + ready * 0.95,
              l1InfoTreeIndex: 1,
              injectedLeafAt: cursor + 4200 + ready * 0.96,
              injectedLeafIndex: 1,
              claimProofAt: cursor + 4200 + ready * 0.97,
              polls: 10
            },
            readyObservedAt: cursor + 4200 + ready,
            claim: {
              txHash: '0xfaketx',
              blockNumber: '2',
              sentAt: cursor + 4300 + ready,
              minedObservedAt: cursor + 8300 + ready,
              gas: {
                blockNumber: '2',
                gasUsed: String(h === 0 ? 150_000 : rnd() < 0.7 ? 228_000 : 177_000),
                effectiveGasPrice: '1000251'
              },
              claimKind: h === 0 ? 'erc20_origin_unlock' : 'erc20_wrapped_mint'
            }
          });
        }
        cursor = end;
        if (!lapOk) break;
      }
      if (lapOk) emit(cursor, 'lap_end', userId, { lapId, outcome: 'LAP_DONE' });
      else {
        emit(cursor, 'lap_end', userId, { lapId, outcome: 'LAP_FAILED' });
        failed += 1;
      }
      laps += 1;
    }
  }

  const resources: Record<string, unknown>[] = [];
  for (let t = 5000; t < durationMs; t += 5000) {
    const sample = {
      toolRssMb: 300 + (t / durationMs) * 900 + rnd() * 20,
      toolCpuPct: 20 + rnd() * 30,
      browserProcesses: [],
      eventLoopDelayP99Ms: 10 + rnd() * 15 + (t % 3_600_000 < 5000 ? 400 : 0)
    };
    resources.push({ ...sample, ts: new Date(startMs + t).toISOString() });
    emit(startMs + t, 'resource_sample', null, sample);
  }
  for (let t = 0; t < durationMs; t += 600_000) {
    emit(startMs + t, 'error', 'u0', {
      errorClass: 'activity_warning',
      message: 'activity_warning[network_id=82]: bridge service not synced',
      endpointClass: 'tracker/activity'
    });
  }
  if (o.errorSample !== undefined) {
    emit(startMs + 1000, 'error', 'u0', {
      errorClass: 'rpc_error',
      message: 'rpc failed',
      endpointClass: 'rpc/BALI_82/eth_call'
    });
  }
  const walletBalances: Record<string, unknown>[] = [];
  for (let t = 0; t < durationMs; t += 300_000) {
    for (const chainKey of ['BALI_82', 'BALI_85']) {
      const wei = String(
        BigInt(Math.round((0.005 - (t / durationMs) * 0.002) * 1e9)) * BigInt(1_000_000_000)
      );
      const rec = {
        chainKey,
        n: o.wallets,
        minWei: wei,
        medianWei: wei,
        maxWei: wei,
        lowest: [{ userId: 'u0', wei }]
      };
      walletBalances.push({ ts: new Date(startMs + t).toISOString(), ...rec });
      emit(startMs + t, 'wallet_balance', null, rec);
    }
  }
  const leaves: Record<string, unknown>[] = [];
  for (let t = 600_000, i = 0; t < durationMs; t += 1_000_000, i += 1) {
    const rec = {
      blockNumber: String(1000 + i),
      leafCount: 5000 + i,
      txHash: '0xfaketx',
      minTimestamp: 1,
      fromPump: o.pump === true && i % 3 === 0
    };
    leaves.push({ ts: new Date(startMs + t).toISOString(), ...rec });
    emit(startMs + t, 'l1_info_leaf', null, rec);
  }
  for (let t = 60_000; t < durationMs; t += 60_000) {
    emit(startMs + t, 'http_window', null, {
      windowMs: 60_000,
      classes: {
        'tracker/activity': {
          ui: {
            n: 40,
            byStatus: t % 1_800_000 === 0 ? { '200': 38, '503': 2 } : { '200': 40 },
            p90: 40 + (t % 7)
          }
        }
      }
    });
  }
  const deposits: Record<string, unknown>[] = [];
  if (o.pump === true) {
    emit(startMs, 'pump_state', 'harness:pump', {
      state: 'started',
      sender: '0x00000000000000000000000000000000000000aa',
      intervalSeconds: 600,
      maxTotalSpendWei: '70000000000000000',
      maxGasPriceWei: '5000000000',
      destinationNetworkId: 82,
      amountWei: '0'
    });
    let spend = BigInt(0);
    for (let t = 0, i = 0; t < durationMs; t += 600_000, i += 1) {
      const cost = BigInt(440_000) * BigInt(1_000_000);
      spend += cost;
      const dep = {
        txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
        blockNumber: String(2000 + i),
        depositCount: i,
        status: 'success',
        gasUsed: '440000',
        effectiveGasPrice: '1000000',
        costWei: cost.toString(),
        cumulativeSpendWei: spend.toString(),
        sentAt: startMs + t,
        minedObservedAt: startMs + t + 12_000
      };
      emit(startMs + t + 12_000, 'pump_deposit', 'harness:pump', dep);
      const { cumulativeSpendWei: _c, ...rest } = dep;
      deposits.push(rest);
    }
  }
  emit(startMs + durationMs, 'run_end', null, {
    aborted: false,
    abortCause: null,
    lapsInFlightAtStop: 0,
    durationMs
  });

  const hopsOk = hops.length;
  const base: Record<string, unknown> = {
    env: 'testnet',
    aggkitProxyUrl: 'https://proxy.example.invalid',
    chains: [
      {
        key: 'BALI_82',
        chainId: 828282,
        networkId: 82,
        rpcUrl: 'http://203.0.113.10:8545',
        bridgeAddress: '0x0000000000000000000000000000000000000001',
        explorerUrl: '',
        nativeSymbol: 'ETH'
      },
      {
        key: 'BALI_85',
        chainId: 858585,
        networkId: 85,
        rpcUrl: 'http://203.0.113.11:8545',
        bridgeAddress: '0x0000000000000000000000000000000000000001',
        explorerUrl: '',
        nativeSymbol: 'ETH'
      }
    ],
    ring: ['BALI_82', 'BALI_85', 'BALI_82'],
    autoclaim: {},
    assets: [
      {
        kind: 'erc20',
        address: '0x0000000000000000000000000000000000000002',
        originNetworkId: 82,
        amount: '0.001',
        decimals: 18
      }
    ],
    users: {
      total: o.wallets,
      browser: 0,
      wallets: { mnemonicRef: { ref: 'env:LOADTEST_MNEMONIC' }, startIndex: 200 },
      funder: {
        privateKeyRef: { ref: 'env:LOADTEST_FUNDER_PRIVATE_KEY' },
        gasPerChain: { BALI_82: '0.005', BALI_85: '0.005' },
        maxTotalSpend: { BALI_82: '0.2', BALI_85: '0.2' }
      }
    },
    load: {
      bridgesPerMinutePerUser: 0.05,
      durationMinutes: o.hours * 60,
      rampUpSeconds: 120,
      maxInflightLapsPerUser: 4
    },
    timeouts: { hopMs: 10_800_000 },
    measurement: {
      stageProbeIntervalMs: 30_000,
      walletBalanceIntervalMs: 300_000,
      httpWindowMs: 60_000
    },
    output: { dir: 'loadtest-results/synthetic', activityLog: true },
    ...(o.pump === true
      ? {
          pump: {
            enabled: true,
            chainKey: 'SEPOLIA',
            destinationNetworkId: 82,
            walletIndex: 99,
            amount: '0',
            intervalSeconds: 600,
            maxTotalSpend: '0.07',
            maxGasPriceGwei: 5
          }
        }
      : {}),
    ...(o.configOverride ?? {})
  };
  const results = {
    schemaVersion: 1,
    run: {
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(startMs + durationMs).toISOString(),
      durationMs,
      aborted: false,
      abortCause: null,
      lapsInFlightAtStop: 0,
      toolVersion: 'synthetic',
      sdkVersion: 'synthetic',
      host: { cores: 8, totalMemMb: 16000, platform: 'linux' }
    },
    config: base,
    requested: { users: o.wallets, browser: 0, ratePerUserPerMin: 0.05, minutes: o.hours * 60 },
    achieved: {
      ticksOffered: ticks,
      lapStartsSubmitted: ticks,
      skippedBackpressure: 0,
      ticksLostToRamp: 0,
      ticksExpected: ticks,
      hopBridgesSubmitted: hopsOk,
      steadyStateRatePerUserPerMin: 0.05,
      steadyStateRatePerUserPerModeMin: { browser: null, headless: 0.05 }
    },
    hops: {
      byOutcome: {
        hop_completed_manual: hopsOk,
        ...(failed > 0 ? { timeout_ready_to_claim: failed } : {})
      },
      byRoute: Object.fromEntries(
        ROUTES.map((r) => [
          r,
          {
            byOutcome: {
              hop_completed_manual: byRoute[r] - (r === ROUTES[1] ? failed : 0),
              ...(r === ROUTES[1] && failed > 0 ? { timeout_ready_to_claim: failed } : {})
            },
            byOutcomeByMode: { browser: {}, headless: {} },
            phases: {}
          }
        ])
      ),
      byRouteMode: Object.fromEntries(
        ROUTES.map((r) => [
          r,
          {
            browser: { attempted: 0, completed: 0, completionRate: null },
            headless: { attempted: byRoute[r], completed: byRoute[r], completionRate: 1 }
          }
        ])
      )
    },
    laps: {
      byOutcome: { LAP_DONE: laps - failed, LAP_FAILED: failed, LAP_ABORTED: 0 },
      byMode: {
        browser: { attempted: 0, completed: 0, completionRate: null },
        headless: {
          attempted: laps,
          completed: laps - failed,
          completionRate: (laps - failed) / Math.max(1, laps)
        }
      }
    },
    phases: {},
    phaseCensoredCounts: {},
    uncontextedRequests: 0,
    http: {},
    gates: {
      'claim-proof': {
        hopsEntered: hopsOk,
        totalMs: hopsOk * 600_000,
        p50: 600_000,
        p90: 900_000,
        p99: 1_200_000,
        blockedTicks: 0,
        timedOutVisits: failed
      }
    },
    errors: {
      byClass: {
        activity_warning: Math.floor(durationMs / 600_000),
        ...(o.errorSample !== undefined ? { rpc_error: 1 } : {})
      },
      top:
        o.errorSample === undefined
          ? []
          : [
              {
                class: 'rpc_error',
                count: 1,
                firstSeen: new Date(startMs).toISOString(),
                lastSeen: new Date(startMs).toISOString(),
                sample: o.errorSample,
                endpointClass: 'rpc/BALI_82/eth_call'
              }
            ],
      suppressed: { notReady: 0, benignExternalAsset: 0 }
    },
    policy: { autoclaimOverdue: 0, unexpectedAutoclaim: 0, claimRaceLost: 0 },
    resources: { samples: resources },
    measurements: {
      probeIntervalMs: 30_000,
      hops,
      claimGas: [
        {
          toNetworkId: 85,
          claimKind: 'erc20_origin_unlock',
          n: 1,
          gasUsed: { n: 1, min: '150000', median: '150000', max: '150000' },
          effectiveGasPrice: { n: 1, min: '1000251', median: '1000251', max: '1000251' },
          l1Fee: null,
          totalFeeWei: { n: 1, min: '150037650000', median: '150037650000', max: '150037650000' }
        }
      ],
      stageLatency: [],
      excludedHops: failed
    },
    ...(o.pump === true
      ? {
          pump: {
            enabled: true,
            sender: '0x00000000000000000000000000000000000000aa',
            destinationNetworkId: 82,
            amountWei: '0',
            intervalSeconds: 600,
            maxTotalSpendWei: '70000000000000000',
            maxGasPriceWei: '5000000000',
            deposits,
            skipped: { gas_price: 0, cap_reached: 0, previous_pending: 0, send_error: 0 },
            totalSpendWei: String(BigInt(440_000) * BigInt(1_000_000) * BigInt(deposits.length)),
            pendingAtStop: false
          }
        }
      : {}),
    walletBalances: { intervalMs: 300_000, samples: walletBalances },
    l1InfoTree: {
      gerManagerAddress: '0x00000000000000000000000000000000000000bb',
      baselineLeafCount: 5000,
      leaves,
      pollErrors: 0
    }
  } as unknown as ResultsJson;
  return { results, ndjson: `${lines.join('\n')}\n`, startMs };
};

/** Writes `<root>/<name>/out/{results.json,activity.ndjson}` and `<root>/<name>/meta.txt`; returns the out dir. */
export const writeRunDir = (
  root: string,
  name: string,
  run: SyntheticRun,
  meta = 'ring=I users=1 minutes=60 rate=0.05'
): string => {
  const out = path.join(root, name, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(run.results));
  fs.writeFileSync(path.join(out, 'activity.ndjson'), run.ndjson);
  fs.writeFileSync(path.join(root, name, 'meta.txt'), `${meta}\n`);
  return out;
};
