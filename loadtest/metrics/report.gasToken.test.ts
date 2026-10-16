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

describe('summary headline — verdict precedence (FAIL / INCOMPLETE / PASS)', () => {
  const normalEnd = { aborted: false, abortCause: null, lapsInFlightAtStop: 0 } as const;

  // Builds results from a one-lap-start run, then overwrites the lap/hop
  // outcome counters with the shape under test (the real-run shapes below).
  const headlineFor = (
    laps: Partial<Record<'LAP_DONE' | 'LAP_FAILED' | 'LAP_ABORTED', number>>,
    hops: Record<string, number>,
    end: Parameters<ReturnType<typeof createCollector>['runEnd']>[0] = normalEnd
  ): string => {
    const config = buildTestDevnetConfig();
    const collector = createCollector();
    collector.runStart({ toolVersion: 'v1', sdkVersion: 'sdk1', host: HOST });
    collector.tick('u1', 'headless');
    collector.runEnd(end);
    const results = buildResultsJson({ snapshot: collector.snapshot(), config });
    results.laps.byOutcome = { LAP_DONE: 0, LAP_FAILED: 0, LAP_ABORTED: 0, ...laps };
    results.hops.byOutcome = hops;
    return renderSummaryMd(results, config).split('\n')[0];
  };

  it('all laps done reads PASS', () => {
    const line = headlineFor({ LAP_DONE: 2 }, { hop_completed_auto: 4 });
    expect(line).toContain(' PASS —');
  });

  it('all laps done with laps drained in flight keeps the drained suffix', () => {
    const line = headlineFor(
      { LAP_DONE: 2 },
      { hop_completed_auto: 4 },
      { ...normalEnd, lapsInFlightAtStop: 2 }
    );
    expect(line).toContain('PASS (drained 2 in-flight laps)');
  });

  it('a failed lap reads FAIL with the top failing hop outcomes', () => {
    const line = headlineFor(
      { LAP_DONE: 1, LAP_FAILED: 2 },
      { hop_completed_auto: 5, timeout_claimed_observed: 2, revert_bridge: 1 }
    );
    expect(line).toContain(
      'FAIL (2 of 3 lap(s) failed: timeout_claimed_observed x2, revert_bridge x1)'
    );
    expect(line).not.toContain('PASS');
  });

  it('an aborted lap (drain deadline) reads INCOMPLETE, not PASS', () => {
    const line = headlineFor(
      { LAP_DONE: 1, LAP_ABORTED: 1 },
      { hop_completed_auto: 2, aborted_drain: 1 }
    );
    expect(line).toContain('INCOMPLETE (1 of 2 lap(s) aborted: aborted_drain x1)');
    expect(line).not.toContain('PASS');
  });

  it('FAIL beats INCOMPLETE when both failed and aborted laps exist', () => {
    const line = headlineFor(
      { LAP_FAILED: 1, LAP_ABORTED: 1 },
      { timeout_hop: 1, aborted_drain: 1 }
    );
    expect(line).toContain('FAIL (1 of 2 lap(s) failed');
    expect(line).not.toContain('INCOMPLETE');
  });

  it('ABORTED (sigint) still wins over failed laps', () => {
    const line = headlineFor(
      { LAP_FAILED: 1 },
      { timeout_hop: 1 },
      { aborted: true, abortCause: 'sigint', lapsInFlightAtStop: 0 }
    );
    expect(line).toContain('ABORTED (sigint)');
    expect(line).not.toContain('FAIL');
  });

  it('real run ringD-20261004T012015Z shape (1 aborted lap, aborted_drain hop) reads INCOMPLETE', () => {
    const line = headlineFor(
      { LAP_DONE: 0, LAP_FAILED: 0, LAP_ABORTED: 1 },
      { hop_completed_auto: 2, aborted_drain: 1 },
      { ...normalEnd, lapsInFlightAtStop: 1 }
    );
    expect(line).toContain('INCOMPLETE (1 of 1 lap(s) aborted: aborted_drain x1)');
  });

  it('real run ringA-run2-20261001T145859Z shape (1 failed lap, timeout_claimed_observed) reads FAIL', () => {
    const line = headlineFor(
      { LAP_FAILED: 1 },
      { timeout_claimed_observed: 1 },
      { ...normalEnd, lapsInFlightAtStop: 1 }
    );
    expect(line).toContain('FAIL (1 of 1 lap(s) failed: timeout_claimed_observed x1)');
  });

  it('zero lap starts still reads NO LAPS STARTED even with stray lap counters', () => {
    const line = headline(() => {}, normalEnd);
    expect(line).toContain('NO LAPS STARTED');
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
