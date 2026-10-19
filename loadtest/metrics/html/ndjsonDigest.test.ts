import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempRoot } from './__fixtures__/load';
import { digestFromFile, digestFromText, emptyDigest } from './ndjsonDigest';

const line = (ts: string, kind: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts, kind, userId: 'u0', mode: 'headless', ...extra });

const T = (s: number): string => new Date(Date.UTC(2026, 9, 14, 9, 0, s)).toISOString();

const SAMPLE = [
  line(T(0), 'run_start', { userId: null, mode: null }),
  line(T(1), 'tick'),
  line(T(2), 'hop_state', {
    hopId: 'u0:a0:l0:h0',
    lapId: 'u0:a0:l0',
    from: 'PLANNED',
    to: 'BRIDGE_BUILD',
    transition: 'T2'
  }),
  line(T(3), 'hop_state', {
    hopId: 'u0:a0:l0:h0',
    lapId: 'u0:a0:l0',
    from: 'BRIDGE_BUILD',
    to: 'AWAITING_READY',
    transition: 'T9'
  }),
  line(T(60), 'hop_end', {
    hopId: 'u0:a0:l0:h0',
    lapId: 'u0:a0:l0',
    hopRoute: 'A->B',
    outcome: 'hop_completed_manual'
  }),
  line(T(61), 'lap_end', { lapId: 'u0:a0:l0', outcome: 'LAP_DONE' }),
  line(T(62), 'error', { errorClass: 'proxy_5xx', message: 'secret text that must not be kept' }),
  line(T(63), 'tick_skipped', { gate: 'claim-proof' }),
  line(T(64), 'resource_sample', {
    userId: null,
    mode: null,
    toolRssMb: 100,
    toolCpuPct: 5,
    browserProcesses: [{ pid: 1, rssMb: 40 }],
    eventLoopDelayP99Ms: 11
  }),
  line(T(65), 'run_end', {
    userId: null,
    mode: null,
    aborted: false,
    abortCause: null,
    durationMs: 65_000
  })
].join('\n');

describe('digestFromText', () => {
  it('reduces hops, laps, counters and series without keeping free text', () => {
    const d = digestFromText(`${SAMPLE}\n`);
    expect(d.lines).toBe(10);
    expect(d.malformed).toBe(0);
    expect([...d.hops.keys()]).toStrictEqual(['u0:a0:l0:h0']);
    const hop = d.hops.get('u0:a0:l0:h0');
    expect(hop?.states.map(([, s]) => s)).toStrictEqual(['BRIDGE_BUILD', 'AWAITING_READY']);
    expect(hop?.outcome).toBe('hop_completed_manual');
    expect(hop?.route).toBe('A->B');
    expect(hop?.hopIndex).toBe(0);
    expect(d.laps.get('u0:a0:l0')?.outcome).toBe('LAP_DONE');
    expect(d.ticks).toBe(1);
    expect(d.ticksSkipped).toBe(1);
    expect(d.errorTotals).toStrictEqual({ proxy_5xx: 1 });
    expect(d.resources[0]).toMatchObject({
      rssMb: 100,
      cpuPct: 5,
      eventLoopP99Ms: 11,
      browserRssMb: 40
    });
    expect(d.runEnd?.aborted).toBe(false);
    expect(JSON.stringify([...d.errorMinutes])).not.toContain('secret');
    const wallet = d.wallets.get('u0');
    expect(wallet).toMatchObject({
      ticks: 1,
      ticksSkipped: 1,
      lapsDone: 1,
      hopsOk: 1,
      hopsFailed: 0
    });
  });

  it('counts malformed lines and marks a truncated last line', () => {
    const d = digestFromText(`${SAMPLE}\n{"ts":"2026-10-14T09:01:`);
    expect(d.malformed).toBe(1);
    expect(d.truncatedTail).toBe(true);
    expect(d.lines).toBe(10);
  });

  it('does not treat a bad line in the middle as a truncated tail', () => {
    const d = digestFromText(`not json\n${SAMPLE}\n`);
    expect(d.malformed).toBe(1);
    expect(d.truncatedTail).toBe(false);
  });

  it('keeps harness users out of the per-wallet counters', () => {
    const d = digestFromText(
      `${line(T(1), 'pump_deposit', { userId: 'harness:pump', txHash: '0xfake', blockNumber: '1', status: 'success' })}\n`
    );
    expect(d.wallets.size).toBe(0);
    expect(d.pump.deposits).toHaveLength(1);
  });
});

describe('digestFromFile', () => {
  it('reports a missing file as not present', async () => {
    const d = await digestFromFile(path.join(makeTempRoot(), 'nope.ndjson'));
    expect(d.present).toBe(false);
    expect(d).toMatchObject({ lines: 0, ...{ hops: emptyDigest().hops } });
  });

  it('streams a file and flags a truncated tail only when the file does not end in a newline', async () => {
    const root = makeTempRoot();
    const ok = path.join(root, 'ok.ndjson');
    fs.writeFileSync(ok, `${SAMPLE}\n`);
    expect((await digestFromFile(ok)).truncatedTail).toBe(false);
    const cut = path.join(root, 'cut.ndjson');
    fs.writeFileSync(cut, `${SAMPLE}\n{"ts":"2026-10-14T09:`);
    const d = await digestFromFile(cut);
    expect(d.truncatedTail).toBe(true);
    expect(d.malformed).toBe(1);
  });
});
