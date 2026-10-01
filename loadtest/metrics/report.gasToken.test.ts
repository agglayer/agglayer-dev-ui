// S07: (a) a run with zero lap starts must not read PASS (S03 §3.1: `--rate 1
// --minutes 1` yields zero laps), and (b) discovered gas-token identities are
// recorded in results.json (S05 SD1 iii guard (a)).
import { describe, expect, it } from 'vitest';

import { buildTestDevnetConfig } from '../wallets/testHelpers';
import { createCollector } from './collector';
import { buildResultsJson, renderSummaryMd } from './report';

const HOST = { cores: 1, totalMemMb: 1, platform: 'linux' };

const headline = (
  setup: (collector: ReturnType<typeof createCollector>) => void,
  end: Parameters<ReturnType<typeof createCollector>['runEnd']>[0]
): string => {
  const config = buildTestDevnetConfig();
  const collector = createCollector();
  collector.runStart({ toolVersion: 'v1', sdkVersion: 'sdk1', host: HOST });
  setup(collector);
  collector.runEnd(end);
  const results = buildResultsJson({ snapshot: collector.snapshot(), config });
  return renderSummaryMd(results, config).split('\n')[0];
};

describe('summary headline — zero lap starts is not a PASS', () => {
  const normalEnd = { aborted: false, abortCause: null, lapsInFlightAtStop: 0 } as const;

  it('a normal-looking run with 0 lap starts reads NO LAPS STARTED, never PASS', () => {
    const line = headline(() => {}, normalEnd);
    expect(line).toContain('NO LAPS STARTED');
    expect(line).not.toContain('PASS');
  });

  it('a run with >= 1 lap start still reads PASS', () => {
    const line = headline((c) => c.tick('u1', 'headless'), normalEnd);
    expect(line).toContain(' PASS —');
    expect(line).not.toContain('NO LAPS STARTED');
  });

  it('a run with exactly one lap start and laps in flight at stop reads PASS (drained ...)', () => {
    const line = headline((c) => c.tick('u1', 'headless'), { ...normalEnd, lapsInFlightAtStop: 1 });
    expect(line).toContain('PASS (drained 1 in-flight lap)');
  });

  it('abort still wins over the zero-lap headline', () => {
    const line = headline(() => {}, { aborted: true, abortCause: 'fatal', lapsInFlightAtStop: 0 });
    expect(line).toContain('ABORTED');
    expect(line).toContain('fatal');
    expect(line).not.toContain('NO LAPS STARTED');
  });
});

describe('results.json — discovered gas-token identities', () => {
  const snapshotOf = () => {
    const collector = createCollector();
    collector.runStart({ toolVersion: 'v1', sdkVersion: 'sdk1', host: HOST });
    collector.runEnd({ aborted: false, abortCause: null, lapsInFlightAtStop: 0 });
    return collector.snapshot();
  };

  it('records each gas-token chain identity (and drops the internal chainKey field)', () => {
    const results = buildResultsJson({
      snapshot: snapshotOf(),
      config: buildTestDevnetConfig(),
      gasTokenChains: {
        L2A: {
          chainKey: 'L2A',
          gasTokenAddress: '0x0000003f0000003f0000003f0000003f0000003f',
          gasTokenNetwork: 63,
          wethToken: '0x77290275947f166793b8d10428670e1fca26960a'
        }
      }
    });
    expect(results.gasTokenChains).toStrictEqual({
      L2A: {
        gasTokenAddress: '0x0000003f0000003f0000003f0000003f0000003f',
        gasTokenNetwork: 63,
        wethToken: '0x77290275947f166793b8d10428670e1fca26960a'
      }
    });
  });

  it('omits gasTokenChains entirely for an ETH-gas run (results.json unchanged)', () => {
    const empty = buildResultsJson({
      snapshot: snapshotOf(),
      config: buildTestDevnetConfig(),
      gasTokenChains: {}
    });
    const absent = buildResultsJson({ snapshot: snapshotOf(), config: buildTestDevnetConfig() });
    expect(empty).not.toHaveProperty('gasTokenChains');
    expect(absent).not.toHaveProperty('gasTokenChains');
  });
});
