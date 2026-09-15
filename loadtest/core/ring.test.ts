// DESIGN §3.2's transition table, asserted row by row with a FAKE CLOCK —
// no timers, no sleeps, no I/O. Every test names the transition ids it
// exercises so a change to §3.2 shows up here as a failing assertion rather
// than as drift.
import type { Hex } from 'viem';

import { describe, expect, it } from 'vitest';

import type { RingEvent } from './ring';
import type {
  ActivityRowStatus,
  Hop,
  HopSpec,
  HopState,
  Lap,
  ObservedRow,
  RingTimeouts,
  TransitionId
} from './types';

import {
  advanceHop,
  advanceLap,
  createFakeClock,
  createHop,
  createRingEngine,
  createRingLap,
  eventsFromBridge,
  eventsFromClaim,
  gateFromClaimInputsReason,
  hopDeadline,
  nextAction
} from './ring';
import { toRowKey } from './types';

// DESIGN §3.3's devnet defaults, as derived at S03 for this devnet.
const TIMEOUTS: RingTimeouts = {
  txReceiptMs: 60_000,
  appearsInActivityMs: 60_000,
  readyToClaimMs: 600_000,
  claimedMs: 600_000,
  hopMs: 900_000,
  lapMs: 2_700_000
};

// The devnet ring L1 -> L2A -> L2B -> L1 with its config's autoclaim map:
// L1->L2A expected/120 s, L2A->L2B expected/300 s, L2B->L1 not expected.
const RING: HopSpec[] = [
  {
    hopIndex: 0,
    hopRoute: 'L1->L2A',
    fromChainKey: 'L1',
    toChainKey: 'L2A',
    fromNetworkId: 0,
    toNetworkId: 1,
    assetIndex: 0,
    assetKind: 'eth',
    amount: '0.01',
    decimals: 18,
    autoclaim: { expected: true, waitMs: 120_000 }
  },
  {
    hopIndex: 1,
    hopRoute: 'L2A->L2B',
    fromChainKey: 'L2A',
    toChainKey: 'L2B',
    fromNetworkId: 1,
    toNetworkId: 2,
    assetIndex: 0,
    assetKind: 'eth',
    amount: '0.01',
    decimals: 18,
    autoclaim: { expected: true, waitMs: 300_000 }
  },
  {
    hopIndex: 2,
    hopRoute: 'L2B->L1',
    fromChainKey: 'L2B',
    toChainKey: 'L1',
    fromNetworkId: 2,
    toNetworkId: 0,
    assetIndex: 0,
    assetKind: 'eth',
    amount: '0.01',
    decimals: 18,
    autoclaim: { expected: false }
  }
];

const ERC20_HOP: HopSpec = {
  ...RING[0],
  assetKind: 'erc20',
  assetAddress: '0x1111111111111111111111111111111111111111',
  assetIndex: 1
};

const TX_A = '0xaaaa000000000000000000000000000000000000000000000000000000000001' as Hex;
const TX_B = '0xbbbb000000000000000000000000000000000000000000000000000000000002' as Hex;
const CLAIM_TX = '0xcccc000000000000000000000000000000000000000000000000000000000003' as Hex;

const makeRow = (
  transactionHash: Hex,
  depositCount: number,
  status: ActivityRowStatus,
  extra: Partial<ObservedRow> = {}
): ObservedRow => ({
  rowKey: toRowKey(transactionHash, depositCount),
  status,
  transactionHash,
  depositCount,
  sourceNetwork: 0,
  destinationNetwork: 1,
  ...extra
});

const currentHop = (lap: Lap): Hop => {
  const hop = lap.hops[lap.currentHopIndex];
  if (hop === undefined) throw new Error('lap has no current hop');
  return hop;
};

const transitions = (emissions: readonly { type: string }[]): TransitionId[] =>
  emissions
    .filter((e): e is { type: 'transition'; transition: TransitionId } => e.type === 'transition')
    .map((e) => e.transition);

const outcomes = (emissions: readonly { type: string }[]): string[] =>
  emissions
    .filter((e): e is { type: 'outcome'; outcome: string } => e.type === 'outcome')
    .map((e) => e.outcome);

const phases = (emissions: readonly { type: string }[]): string[] =>
  emissions
    .filter((e): e is { type: 'phase'; phase: string } => e.type === 'phase')
    .map((e) => e.phase);

const setup = (startAt = 1_000) => {
  const clock = createFakeClock(startAt);
  const engine = createRingEngine({ clock, timeouts: TIMEOUTS });
  return { clock, engine };
};

// Drives PLANNED -> AWAITING_ACTIVITY for an ETH hop (T2, T7, T9).
const bridgeOk = (
  lap: Lap,
  engine: ReturnType<typeof createRingEngine>,
  clock: ReturnType<typeof createFakeClock>,
  txHash: Hex,
  depositCount: number,
  sink?: TransitionId[]
): Lap => {
  const run = (current: Lap, event: RingEvent): Lap => {
    const step = engine.apply(current, event);
    sink?.push(...transitions(step.emissions));
    return step.lap;
  };
  let next = run(lap, { kind: 'allowance', sufficient: true });
  clock.advance(500);
  next = run(next, { kind: 'bridge_sent', txHash });
  clock.advance(2_000);
  next = run(next, {
    kind: 'bridge_receipt',
    status: 'success',
    depositCount,
    bridgeEventFound: true
  });
  return next;
};

// Builds a hop parked in `state` at t=0 with no accumulated history, so a
// per-state timeout can be asserted without the earlier states' elapsed
// time eating into the `hopMs` umbrella.
const hopInState = (state: HopState, overrides: Partial<Hop> = {}): Hop => ({
  ...createHop({ userId: 'u0', lapId: 'u0:a0:l0', lapIndex: 0, spec: RING[0], startedAt: 0 }),
  state,
  ...overrides
});

describe('ring — full ETH lap, auto / auto / manual (T2,T7,T9,T12,T13,T17,T14,T19,T21,T23,T26,L1,L2)', () => {
  it('completes three hops and reports the lap DONE', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    const seen: TransitionId[] = [];
    const record = (step: { lap: Lap; emissions: readonly { type: string }[] }): Lap => {
      seen.push(...transitions(step.emissions));
      return step.lap;
    };

    // ---- hop 0: L1->L2A, autoclaim expected, autoclaimed inside the window
    lap = bridgeOk(lap, engine, clock, TX_A, 7, seen);
    expect(currentHop(lap).state).toBe('AWAITING_ACTIVITY');
    expect(currentHop(lap).rowKey).toBe(`${TX_A}:7`);
    expect(nextAction(currentHop(lap))).toEqual({ kind: 'observe_activity' });

    clock.advance(4_000);
    lap = record(engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 7, 'PENDING')] }));
    expect(currentHop(lap).state).toBe('AWAITING_READY');
    expect(currentHop(lap).currentGate).toBe('claim-proof');

    clock.advance(30_000);
    lap = record(
      engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 7, 'READY_TO_CLAIM')] })
    );
    expect(currentHop(lap).state).toBe('AWAITING_AUTOCLAIM');
    expect(currentHop(lap).currentGate).toBe('claimed');
    expect(currentHop(lap).readyAt).toBe(clock.now());

    clock.advance(20_000);
    lap = record(engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 7, 'CLAIMED')] }));
    expect(lap.hops[0]?.outcome).toBe('hop_completed_auto');
    expect(lap.currentHopIndex).toBe(1);
    expect(currentHop(lap).spec.hopRoute).toBe('L2A->L2B');
    expect(currentHop(lap).state).toBe('PLANNED');

    // ---- hop 1: L2A->L2B, autoclaim expected, autoclaimed
    lap = bridgeOk(lap, engine, clock, TX_B, 3, seen);
    clock.advance(5_000);
    lap = record(engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_B, 3, 'PENDING')] }));
    clock.advance(60_000);
    lap = record(
      engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_B, 3, 'READY_TO_CLAIM')] })
    );
    clock.advance(90_000);
    lap = record(engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_B, 3, 'CLAIMED')] }));
    expect(lap.hops[1]?.outcome).toBe('hop_completed_auto');
    expect(lap.currentHopIndex).toBe(2);

    // ---- hop 2: L2B->L1, autoclaim NOT expected -> manual claim
    const txC = '0xdddd000000000000000000000000000000000000000000000000000000000004' as Hex;
    lap = bridgeOk(lap, engine, clock, txC, 11, seen);
    clock.advance(4_000);
    lap = record(engine.apply(lap, { kind: 'activity', rows: [makeRow(txC, 11, 'PENDING')] }));
    clock.advance(200_000);
    lap = record(
      engine.apply(lap, { kind: 'activity', rows: [makeRow(txC, 11, 'READY_TO_CLAIM')] })
    );
    // T14, not T13: `expected === false` goes straight to CLAIM_BUILD.
    expect(currentHop(lap).state).toBe('CLAIM_BUILD');
    expect(currentHop(lap).claimStep).toBe('is_claimed');
    expect(nextAction(currentHop(lap))).toEqual({ kind: 'claim' });

    clock.advance(300);
    lap = record(engine.apply(lap, { kind: 'is_claimed', claimed: false }));
    clock.advance(1_200);
    lap = record(engine.apply(lap, { kind: 'claim_inputs', claimable: true }));
    clock.advance(800);
    lap = record(engine.apply(lap, { kind: 'claim_sent', txHash: CLAIM_TX }));
    expect(currentHop(lap).state).toBe('CLAIM_PENDING');
    clock.advance(3_000);
    lap = record(
      engine.apply(lap, { kind: 'claim_receipt', status: 'success', isClaimedRecheck: null })
    );
    expect(currentHop(lap).state).toBe('AWAITING_CLAIMED');
    expect(currentHop(lap).currentGate).toBe('claimed');

    clock.advance(6_000);
    const last = engine.apply(lap, {
      kind: 'activity',
      rows: [makeRow(txC, 11, 'CLAIMED', { claimTransactionHash: CLAIM_TX })]
    });
    seen.push(...transitions(last.emissions));
    lap = last.lap;

    expect(lap.state).toBe('LAP_DONE');
    expect(lap.hops[2]?.outcome).toBe('hop_completed_manual');
    expect(lap.hops.map((hop) => hop.outcome)).toEqual([
      'hop_completed_auto',
      'hop_completed_auto',
      'hop_completed_manual'
    ]);
    expect(seen).toEqual([
      'T2',
      'T7',
      'T9',
      'T12',
      'T13',
      'T17',
      'T2',
      'T7',
      'T9',
      'T12',
      'T13',
      'T17',
      'T2',
      'T7',
      'T9',
      'T12',
      'T14',
      'T21',
      'T23',
      'T26'
    ]);
    expect(phases(last.emissions)).toContain('lap_total');
    // Note N5: only successful hops/laps contribute a latency sample.
    expect(lap.hops.every((hop) => hop.phases.some((p) => p.phase === 'hop_total'))).toBe(true);
    // No autoclaim surprise anywhere in a clean lap.
    expect(lap.hops.map((hop) => hop.counters.unexpected_autoclaim)).toEqual([0, 0, 0]);
    expect(lap.hops.map((hop) => hop.counters.autoclaim_overdue)).toEqual([0, 0, 0]);
  });

  it('records the ERC20 allowance + approve path (T1,T3,T5) and skips them for ETH (T2)', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({
      userId: 'u0',
      lapIndex: 0,
      assetIndex: 1,
      hopSpecs: [ERC20_HOP]
    });
    clock.advance(400);
    let step = engine.apply(lap, { kind: 'allowance', sufficient: false });
    expect(transitions(step.emissions)).toEqual(['T1']);
    expect(phases(step.emissions)).toEqual(['allowance']);
    lap = step.lap;
    clock.advance(700);
    step = engine.apply(lap, { kind: 'approve_sent', txHash: TX_A });
    expect(transitions(step.emissions)).toEqual(['T3']);
    lap = step.lap;
    clock.advance(2_500);
    step = engine.apply(lap, { kind: 'approve_receipt', status: 'success' });
    expect(transitions(step.emissions)).toEqual(['T5']);
    expect(step.lap.hops[0]?.state).toBe('BRIDGE_BUILD');

    // ETH: no `allowance` phase at all (DESIGN §3.2 T2's "ERC20 only").
    const eth = setup();
    const ethLap = eth.engine.startLap({
      userId: 'u1',
      lapIndex: 0,
      assetIndex: 0,
      hopSpecs: RING
    });
    const ethStep = eth.engine.apply(ethLap, { kind: 'allowance', sufficient: true });
    expect(transitions(ethStep.emissions)).toEqual(['T2']);
    expect(phases(ethStep.emissions)).toEqual([]);
  });
});

describe('ring — autoclaim escalation (T18) is a COUNTER, not a failure', () => {
  it('escalates to a manual claim and still completes as hop_completed_escalated (T26)', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = bridgeOk(lap, engine, clock, TX_A, 1);
    clock.advance(3_000);
    lap = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 1, 'READY_TO_CLAIM')] }).lap;
    expect(currentHop(lap).state).toBe('AWAITING_AUTOCLAIM');
    const readyAt = currentHop(lap).readyAt;
    expect(readyAt).not.toBeNull();

    // One millisecond before the grace window closes: nothing happens.
    clock.set((readyAt ?? 0) + 120_000 - 1);
    let step = engine.apply(lap, { kind: 'tick' });
    expect(step.emissions).toEqual([]);
    expect(step.lap.hops[0]?.state).toBe('AWAITING_AUTOCLAIM');

    // At readyAt + waitMs exactly (mirrors app/utils/autoclaim.ts's
    // `now >= readyAt + waitMs`): escalate.
    clock.set((readyAt ?? 0) + 120_000);
    step = engine.apply(step.lap, { kind: 'tick' });
    lap = step.lap;
    expect(transitions(step.emissions)).toEqual(['T18']);
    expect(step.emissions).toEqual(
      expect.arrayContaining([
        { type: 'counter', counter: 'autoclaim_overdue', at: clock.now() },
        // The `claimed` gate stall is recorded on the way out (§3.4).
        expect.objectContaining({ type: 'gate_exit', gate: 'claimed' })
      ])
    );
    expect(currentHop(lap).state).toBe('CLAIM_BUILD');
    expect(currentHop(lap).escalated).toBe(true);
    expect(currentHop(lap).counters.autoclaim_overdue).toBe(1);
    // Not a failure, and not a terminal outcome yet.
    expect(outcomes(step.emissions)).toEqual([]);

    // The manual claim then completes normally.
    clock.advance(200);
    lap = engine.apply(lap, { kind: 'is_claimed', claimed: false }).lap;
    clock.advance(900);
    lap = engine.apply(lap, { kind: 'claim_inputs', claimable: true }).lap;
    clock.advance(600);
    lap = engine.apply(lap, { kind: 'claim_sent', txHash: CLAIM_TX }).lap;
    clock.advance(2_000);
    lap = engine.apply(lap, {
      kind: 'claim_receipt',
      status: 'success',
      isClaimedRecheck: null
    }).lap;
    clock.advance(5_000);
    const final = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 1, 'CLAIMED')] });

    expect(transitions(final.emissions)).toEqual(['T26']);
    expect(final.lap.hops[0]?.outcome).toBe('hop_completed_escalated');
    expect(final.lap.hops[0]?.counters.autoclaim_overdue).toBe(1);
    expect(final.lap.currentHopIndex).toBe(1);
  });

  it('does not re-enter the grace window after escalating (note N1: T13 guard)', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = bridgeOk(lap, engine, clock, TX_A, 1);
    clock.advance(1_000);
    lap = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 1, 'READY_TO_CLAIM')] }).lap;
    clock.advance(120_000);
    lap = engine.apply(lap, { kind: 'tick' }).lap; // T18
    clock.advance(100);
    lap = engine.apply(lap, { kind: 'is_claimed', claimed: false }).lap;
    clock.advance(100);
    // T20 sends us back to AWAITING_READY.
    const back = engine.apply(lap, {
      kind: 'claim_inputs',
      claimable: false,
      reason: 'SOURCE_NOT_ON_L1_INFO_TREE'
    });
    expect(transitions(back.emissions)).toEqual(['T20']);
    expect(back.lap.hops[0]?.state).toBe('AWAITING_READY');
    expect(back.lap.hops[0]?.currentGate).toBe('l1-info-tree-index');
    expect(back.lap.hops[0]?.counters.not_yet_claimable).toBe(1);

    clock.advance(1_000);
    const again = engine.apply(back.lap, {
      kind: 'activity',
      rows: [makeRow(TX_A, 1, 'READY_TO_CLAIM')]
    });
    // T14, not T13: already escalated, so the grace window is not re-entered
    // and `autoclaim_overdue` is not double-counted.
    expect(transitions(again.emissions)).toEqual(['T14']);
    expect(again.lap.hops[0]?.counters.autoclaim_overdue).toBe(1);

    // R28 (loadtest/REVIEW.md): note N2 says T20's re-entry "does not
    // re-record the ready_to_claim phase" — this line failed (2 entries)
    // before the fix. The T20 retry cycle drove THREE `activity` events
    // through AWAITING_READY (the initial one at the top of this test, plus
    // this one), so an un-gated recording would produce 2 samples here.
    expect(again.lap.hops[0]?.phases.filter((p) => p.phase === 'ready_to_claim')).toHaveLength(1);
  });
});

describe('ring — a lost claim race is a SUCCESS (T19 / T22 / T24)', () => {
  const claimReady = (): {
    clock: ReturnType<typeof createFakeClock>;
    lap: Lap;
    engine: ReturnType<typeof createRingEngine>;
  } => {
    const { clock, engine } = setup();
    let lap = engine.startLap({
      userId: 'u0',
      lapIndex: 0,
      assetIndex: 0,
      hopSpecs: [RING[2]]
    });
    lap = bridgeOk(lap, engine, clock, TX_A, 5);
    clock.advance(2_000);
    lap = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 5, 'READY_TO_CLAIM')] }).lap;
    return { clock, lap, engine };
  };

  it('T19: isClaimed is already true before we build', () => {
    const { clock, lap, engine } = claimReady();
    clock.advance(300);
    const step = engine.apply(lap, { kind: 'is_claimed', claimed: true });
    expect(transitions(step.emissions)).toEqual(['T19']);
    expect(outcomes(step.emissions)).toEqual(['hop_completed_raced']);
    expect(step.lap.hops[0]?.counters.claim_race_lost).toBe(1);
    expect(step.lap.hops[0]?.state).toBe('DONE');
    expect(step.lap.state).toBe('LAP_DONE');
  });

  it('T22: the build/send throws AlreadyClaimed()', () => {
    const { clock, lap, engine } = claimReady();
    clock.advance(300);
    let next = engine.apply(lap, { kind: 'is_claimed', claimed: false }).lap;
    clock.advance(400);
    next = engine.apply(next, { kind: 'claim_inputs', claimable: true }).lap;
    clock.advance(400);
    const step = engine.apply(next, {
      kind: 'submit_error',
      step: 'claim',
      error: { message: 'execution reverted: 0x646cf558', errorClass: 'already_claimed' }
    });
    expect(transitions(step.emissions)).toEqual(['T22']);
    expect(outcomes(step.emissions)).toEqual(['hop_completed_raced']);
    expect(step.lap.hops[0]?.counters.claim_race_lost).toBe(1);
  });

  it('T24: the claim receipt reverted but the post-revert re-check reads true', () => {
    const { clock, lap, engine } = claimReady();
    clock.advance(300);
    let next = engine.apply(lap, { kind: 'is_claimed', claimed: false }).lap;
    clock.advance(400);
    next = engine.apply(next, { kind: 'claim_inputs', claimable: true }).lap;
    clock.advance(400);
    next = engine.apply(next, { kind: 'claim_sent', txHash: CLAIM_TX }).lap;
    clock.advance(3_000);
    const step = engine.apply(next, {
      kind: 'claim_receipt',
      status: 'reverted',
      isClaimedRecheck: true
    });
    expect(transitions(step.emissions)).toEqual(['T24']);
    expect(outcomes(step.emissions)).toEqual(['hop_completed_raced']);
    expect(step.lap.hops[0]?.counters.claim_race_lost).toBe(1);
  });

  it('T25: reverted with the re-check reading false is a genuine failure', () => {
    const { clock, lap, engine } = claimReady();
    clock.advance(300);
    let next = engine.apply(lap, { kind: 'is_claimed', claimed: false }).lap;
    clock.advance(400);
    next = engine.apply(next, { kind: 'claim_inputs', claimable: true }).lap;
    clock.advance(400);
    next = engine.apply(next, { kind: 'claim_sent', txHash: CLAIM_TX }).lap;
    clock.advance(3_000);
    const step = engine.apply(next, {
      kind: 'claim_receipt',
      status: 'reverted',
      isClaimedRecheck: false
    });
    expect(transitions(step.emissions)).toEqual(['T25']);
    expect(outcomes(step.emissions)).toEqual(['revert_claim']);
    expect(step.lap.state).toBe('LAP_FAILED');
  });
});

describe('ring — activity status ERROR (T16)', () => {
  it('maps `claimed === "error"` to activity_status_error, never to "not claimed"', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = bridgeOk(lap, engine, clock, TX_A, 2);
    clock.advance(3_000);
    const step = engine.apply(lap, {
      kind: 'activity',
      rows: [makeRow(TX_A, 2, 'ERROR', { statusError: 'no bridge address configured' })]
    });
    // T12 then T16 within one poll (note N4's cascade).
    expect(transitions(step.emissions)).toEqual(['T12', 'T16']);
    expect(outcomes(step.emissions)).toEqual(['activity_status_error']);
    expect(step.lap.hops[0]?.state).toBe('FAILED');
    expect(step.lap.state).toBe('LAP_FAILED');
    // The row was NOT treated as an unclaimed row that keeps polling.
    expect(step.lap.hops[0]?.phases.map((p) => p.phase)).not.toContain('ready_to_claim');
  });

  it('also fails from AWAITING_AUTOCLAIM', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = bridgeOk(lap, engine, clock, TX_A, 2);
    clock.advance(1_000);
    lap = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 2, 'READY_TO_CLAIM')] }).lap;
    clock.advance(1_000);
    const step = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 2, 'ERROR')] });
    expect(outcomes(step.emissions)).toEqual(['activity_status_error']);
  });
});

describe('ring — unexpected autoclaim (T27) is a COUNTER, not a failure', () => {
  it('completes the hop as hop_completed_auto and records the counter', () => {
    const { clock, engine } = setup();
    // L2B->L1 expects NO autoclaim.
    let lap = engine.startLap({
      userId: 'u0',
      lapIndex: 0,
      assetIndex: 0,
      hopSpecs: [RING[2]]
    });
    lap = bridgeOk(lap, engine, clock, TX_A, 9);
    clock.advance(4_000);
    lap = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 9, 'PENDING')] }).lap;
    clock.advance(30_000);
    const step = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 9, 'CLAIMED')] });
    expect(transitions(step.emissions)).toEqual(['T27']);
    expect(outcomes(step.emissions)).toEqual(['hop_completed_auto']);
    expect(step.lap.hops[0]?.counters.unexpected_autoclaim).toBe(1);
    expect(step.lap.state).toBe('LAP_DONE');
  });
});

describe('ring — row identity is tx_hash:deposit_count (DESIGN §9.2)', () => {
  it('ignores a sibling deposit in the same tx and a row with a shared content hash', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = bridgeOk(lap, engine, clock, TX_A, 7);
    clock.advance(2_000);

    // Same tx hash, WRONG deposit_count -> not our row. A `bridge_hash`-keyed
    // implementation would have matched it (identical amount/receiver).
    const wrong = engine.apply(lap, {
      kind: 'activity',
      rows: [makeRow(TX_A, 6, 'CLAIMED'), makeRow(TX_B, 7, 'CLAIMED')]
    });
    expect(wrong.emissions).toEqual([]);
    expect(wrong.lap.hops[0]?.state).toBe('AWAITING_ACTIVITY');

    const right = engine.apply(wrong.lap, {
      kind: 'activity',
      rows: [makeRow(TX_A, 6, 'CLAIMED'), makeRow(TX_A, 7, 'PENDING')]
    });
    expect(transitions(right.emissions)).toEqual(['T12']);
    expect(right.lap.hops[0]?.rowKey).toBe(`${TX_A}:7`);
  });
});

describe('ring — bridge-side failures (T6, T8, T10, T11)', () => {
  it('T6: a reverted approve', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 1, hopSpecs: [ERC20_HOP] });
    lap = engine.apply(lap, { kind: 'allowance', sufficient: false }).lap;
    clock.advance(500);
    lap = engine.apply(lap, { kind: 'approve_sent', txHash: TX_A }).lap;
    clock.advance(2_000);
    const step = engine.apply(lap, { kind: 'approve_receipt', status: 'reverted' });
    expect(transitions(step.emissions)).toEqual(['T6']);
    expect(outcomes(step.emissions)).toEqual(['revert_approve']);
  });

  it('T8: LocalBalanceTreeUnderflow is its own outcome, from the message alone', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = engine.apply(lap, { kind: 'allowance', sufficient: true }).lap;
    clock.advance(200);
    const step = engine.apply(lap, {
      kind: 'submit_error',
      step: 'bridge',
      error: { message: 'execution reverted: LocalBalanceTreeUnderflow()' }
    });
    expect(transitions(step.emissions)).toEqual(['T8']);
    expect(outcomes(step.emissions)).toEqual(['lbt_underflow']);
  });

  it('T8: a classified error class is used verbatim', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = engine.apply(lap, { kind: 'allowance', sufficient: true }).lap;
    clock.advance(200);
    const step = engine.apply(lap, {
      kind: 'submit_error',
      step: 'bridge',
      error: { message: 'boom', errorClass: 'rpc_error' }
    });
    expect(outcomes(step.emissions)).toEqual(['rpc_error']);
  });

  it('T10: a reverted bridge', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = engine.apply(lap, { kind: 'allowance', sufficient: true }).lap;
    clock.advance(300);
    lap = engine.apply(lap, { kind: 'bridge_sent', txHash: TX_A }).lap;
    clock.advance(2_000);
    const step = engine.apply(lap, {
      kind: 'bridge_receipt',
      status: 'reverted',
      depositCount: null,
      bridgeEventFound: false
    });
    expect(transitions(step.emissions)).toEqual(['T10']);
    expect(outcomes(step.emissions)).toEqual(['revert_bridge']);
  });

  it('T11: a successful receipt with no BridgeEvent log', () => {
    const { clock, engine } = setup();
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = engine.apply(lap, { kind: 'allowance', sufficient: true }).lap;
    clock.advance(300);
    lap = engine.apply(lap, { kind: 'bridge_sent', txHash: TX_A }).lap;
    clock.advance(2_000);
    const step = engine.apply(lap, {
      kind: 'bridge_receipt',
      status: 'success',
      depositCount: null,
      bridgeEventFound: false
    });
    expect(transitions(step.emissions)).toEqual(['T11']);
    expect(outcomes(step.emissions)).toEqual(['bridge_event_missing']);
  });
});

describe('ring — every phase timeout produces the right outcome (DESIGN §3.2)', () => {
  interface Case {
    name: string;
    hop: Hop;
    firesAt: number;
    outcome: string;
  }

  const cases: Case[] = [
    {
      name: 'APPROVE_BUILD -> timeout_approve_submit (txReceiptMs)',
      hop: hopInState('APPROVE_BUILD'),
      firesAt: TIMEOUTS.txReceiptMs,
      outcome: 'timeout_approve_submit'
    },
    {
      name: 'APPROVE_PENDING -> timeout_approve_receipt (txReceiptMs)',
      hop: hopInState('APPROVE_PENDING'),
      firesAt: TIMEOUTS.txReceiptMs,
      outcome: 'timeout_approve_receipt'
    },
    {
      name: 'BRIDGE_BUILD -> timeout_bridge_submit (txReceiptMs)',
      hop: hopInState('BRIDGE_BUILD'),
      firesAt: TIMEOUTS.txReceiptMs,
      outcome: 'timeout_bridge_submit'
    },
    {
      name: 'BRIDGE_PENDING -> timeout_bridge_receipt (txReceiptMs)',
      hop: hopInState('BRIDGE_PENDING'),
      firesAt: TIMEOUTS.txReceiptMs,
      outcome: 'timeout_bridge_receipt'
    },
    {
      name: 'AWAITING_ACTIVITY -> timeout_appears_in_activity (appearsInActivityMs)',
      hop: hopInState('AWAITING_ACTIVITY'),
      firesAt: TIMEOUTS.appearsInActivityMs,
      outcome: 'timeout_appears_in_activity'
    },
    {
      name: 'AWAITING_READY -> timeout_ready_to_claim (readyToClaimMs)',
      hop: hopInState('AWAITING_READY'),
      firesAt: TIMEOUTS.readyToClaimMs,
      outcome: 'timeout_ready_to_claim'
    },
    {
      name: 'CLAIM_BUILD/is_claimed -> timeout_claim_build (claimedMs)',
      hop: hopInState('CLAIM_BUILD', { claimStep: 'is_claimed' }),
      firesAt: TIMEOUTS.claimedMs,
      outcome: 'timeout_claim_build'
    },
    {
      name: 'CLAIM_BUILD/claim_inputs -> timeout_not_claimable (claimedMs)',
      hop: hopInState('CLAIM_BUILD', { claimStep: 'claim_inputs' }),
      firesAt: TIMEOUTS.claimedMs,
      outcome: 'timeout_not_claimable'
    },
    {
      name: 'CLAIM_BUILD/submit -> timeout_claim_submit (claimedMs)',
      hop: hopInState('CLAIM_BUILD', { claimStep: 'submit' }),
      firesAt: TIMEOUTS.claimedMs,
      outcome: 'timeout_claim_submit'
    },
    {
      name: 'CLAIM_PENDING -> timeout_claim_receipt (txReceiptMs)',
      hop: hopInState('CLAIM_PENDING'),
      firesAt: TIMEOUTS.txReceiptMs,
      outcome: 'timeout_claim_receipt'
    },
    {
      name: 'AWAITING_CLAIMED -> timeout_claimed_observed (claimedMs)',
      hop: hopInState('AWAITING_CLAIMED'),
      firesAt: TIMEOUTS.claimedMs,
      outcome: 'timeout_claimed_observed'
    }
  ];

  it.each(cases)('$name', ({ hop, firesAt, outcome }) => {
    // One millisecond early: nothing fires.
    const early = advanceHop(hop, { kind: 'tick' }, { now: firesAt - 1, timeouts: TIMEOUTS });
    expect(early.emissions).toEqual([]);
    expect(early.hop.state).toBe(hop.state);

    const fired = advanceHop(hop, { kind: 'tick' }, { now: firesAt, timeouts: TIMEOUTS });
    expect(outcomes(fired.emissions)).toEqual([outcome]);
    expect(fired.hop.state).toBe('FAILED');
    expect(fired.hop.timeouts).toEqual([outcome]);
    // The deadline the runner would have raced against agrees.
    expect(hopDeadline(hop, TIMEOUTS)).toEqual(expect.objectContaining({ at: firesAt, outcome }));
  });

  it('PLANNED has no phase deadline of its own — only the hopMs umbrella', () => {
    expect(hopDeadline(hopInState('PLANNED'), TIMEOUTS)).toBeNull();
    const fired = advanceHop(
      hopInState('PLANNED'),
      { kind: 'tick' },
      { now: TIMEOUTS.hopMs, timeouts: TIMEOUTS }
    );
    expect(outcomes(fired.emissions)).toEqual(['timeout_hop']);
  });

  it('AWAITING_AUTOCLAIM has a deadline with NO failure outcome (it escalates)', () => {
    const hop = hopInState('AWAITING_AUTOCLAIM', { readyAt: 1_000 });
    expect(hopDeadline(hop, TIMEOUTS)).toEqual({
      at: 121_000,
      key: 'autoclaimWaitMs',
      outcome: null
    });
  });

  it('T28: hopMs is the umbrella, and a phase timeout that also fired is recorded too', () => {
    // AWAITING_CLAIMED entered late enough that `hopMs` beats `claimedMs`.
    const hop = hopInState('AWAITING_CLAIMED', {
      stateEnteredAt: 250_000,
      stepStartedAt: 250_000
    });
    const fired = advanceHop(
      hop,
      { kind: 'tick' },
      { now: TIMEOUTS.hopMs + 1, timeouts: TIMEOUTS }
    );
    expect(transitions(fired.emissions)).toEqual(['T28']);
    expect(outcomes(fired.emissions)).toEqual(['timeout_hop']);
    expect(fired.emissions).toEqual(
      expect.arrayContaining([
        { type: 'secondary_timeout', timeout: 'timeout_claimed_observed', at: TIMEOUTS.hopMs + 1 }
      ])
    );
    // §5.5 invariant 2 still holds: exactly one terminal outcome.
    expect(fired.hop.outcome).toBe('timeout_hop');
    expect(fired.hop.timeouts).toEqual(['timeout_claimed_observed', 'timeout_hop']);
  });

  it('T29: drain aborts a non-terminal hop, and T30 records a browser crash', () => {
    const hop = hopInState('AWAITING_READY');
    const drained = advanceHop(
      hop,
      { kind: 'tick' },
      { now: 5_000, timeouts: TIMEOUTS, drain: { deadlineAt: 5_000 } }
    );
    expect(transitions(drained.emissions)).toEqual(['T29']);
    expect(outcomes(drained.emissions)).toEqual(['aborted_drain']);

    const crashed = advanceHop(hop, { kind: 'browser_crash' }, { now: 5_000, timeouts: TIMEOUTS });
    expect(transitions(crashed.emissions)).toEqual(['T30']);
    expect(outcomes(crashed.emissions)).toEqual(['browser_crash']);
  });

  it('R30: a STANDALONE phase timeout is labelled with its own §3.2 transition id, not T28', () => {
    // AWAITING_READY with autoclaim expected -> T13 on timeout (not T14,
    // and NOT 'T28' — 'T28' is the hopMs umbrella's own id, handled by a
    // separate branch/test above).
    const readyExpected = hopInState('AWAITING_READY');
    const firedExpected = advanceHop(
      readyExpected,
      { kind: 'tick' },
      { now: TIMEOUTS.readyToClaimMs, timeouts: TIMEOUTS }
    );
    expect(transitions(firedExpected.emissions)).toEqual(['T13']);

    // AWAITING_READY with autoclaim NOT expected -> T14 on timeout.
    const readyNotExpected = hopInState('AWAITING_READY', {
      spec: { ...RING[0], autoclaim: { expected: false } }
    });
    const firedNotExpected = advanceHop(
      readyNotExpected,
      { kind: 'tick' },
      { now: TIMEOUTS.readyToClaimMs, timeouts: TIMEOUTS }
    );
    expect(transitions(firedNotExpected.emissions)).toEqual(['T14']);

    // CLAIM_BUILD/claim_inputs -> T20 (not T28) on its own timeout.
    const claimInputs = hopInState('CLAIM_BUILD', { claimStep: 'claim_inputs' });
    const firedClaimInputs = advanceHop(
      claimInputs,
      { kind: 'tick' },
      { now: TIMEOUTS.claimedMs, timeouts: TIMEOUTS }
    );
    expect(transitions(firedClaimInputs.emissions)).toEqual(['T20']);
  });

  it('R2: a phase that times out records a CENSORED sample, not no sample at all', () => {
    const hop = hopInState('AWAITING_READY', { stateEnteredAt: 1_000 });
    const fired = advanceHop(
      hop,
      { kind: 'tick' },
      { now: 1_000 + TIMEOUTS.readyToClaimMs, timeouts: TIMEOUTS }
    );
    const readyPhases = fired.hop.phases.filter((p) => p.phase === 'ready_to_claim');
    expect(readyPhases).toHaveLength(1);
    expect(readyPhases[0]).toMatchObject({
      durationMs: TIMEOUTS.readyToClaimMs,
      censored: true
    });
    expect(phases(fired.emissions)).toContain('ready_to_claim');
    expect(fired.emissions).toContainEqual(
      expect.objectContaining({ type: 'phase', phase: 'ready_to_claim', censored: true })
    );
  });

  it('R2: the SECONDARY phase timeout (T28/T29 combined with a phase deadline) is also censored', () => {
    // Same fixture as the existing T28 test above: AWAITING_CLAIMED entered
    // late enough that hopMs beats claimedMs.
    const hop = hopInState('AWAITING_CLAIMED', {
      stateEnteredAt: 250_000,
      stepStartedAt: 250_000
    });
    const fired = advanceHop(
      hop,
      { kind: 'tick' },
      { now: TIMEOUTS.hopMs + 1, timeouts: TIMEOUTS }
    );
    const claimedObservedPhases = fired.hop.phases.filter((p) => p.phase === 'claimed_observed');
    expect(claimedObservedPhases).toHaveLength(1);
    expect(claimedObservedPhases[0]?.censored).toBe(true);
    // hop_total is NOT recorded (note N5: only a SUCCESS records it) and is
    // not itself a censored sample — only one phase sample total.
    expect(fired.hop.phases.filter((p) => p.phase === 'hop_total')).toHaveLength(0);
  });

  it('R6: a gate visit that ends at a timeout is tagged timedOut on its gate_exit emission', () => {
    const hop = hopInState('AWAITING_READY', { currentGate: 'claim-proof' });
    const fired = advanceHop(
      hop,
      { kind: 'tick' },
      { now: TIMEOUTS.readyToClaimMs, timeouts: TIMEOUTS }
    );
    expect(fired.emissions).toContainEqual(
      expect.objectContaining({ type: 'gate_exit', gate: 'claim-proof', timedOut: true })
    );
  });

  it('L4: an aborted hop aborts its lap; L3: a failed hop fails it', () => {
    const lap = createRingLap({
      userId: 'u0',
      lapIndex: 0,
      assetIndex: 0,
      hopSpecs: RING,
      startedAt: 0
    });
    const aborted = advanceLap(
      lap,
      { kind: 'tick' },
      { now: 10_000, timeouts: TIMEOUTS, drain: { deadlineAt: 10_000 } }
    );
    expect(aborted.lap.state).toBe('LAP_ABORTED');
    expect(aborted.emissions).toEqual(
      expect.arrayContaining([
        { type: 'lap_transition', transition: 'L4', lapState: 'LAP_ABORTED', at: 10_000 }
      ])
    );
  });

  it('lapMs fails the lap and gives the outstanding hop its one terminal outcome (note N6)', () => {
    const lap = createRingLap({
      userId: 'u0',
      lapIndex: 0,
      assetIndex: 0,
      hopSpecs: RING,
      startedAt: 0
    });
    // Park the current hop in a state whose own deadlines are still open at
    // t = lapMs, so it is the LAP umbrella that fires.
    const parked: Lap = {
      ...lap,
      hops: [
        {
          ...lap.hops[0]!,
          state: 'AWAITING_READY',
          startedAt: TIMEOUTS.lapMs - 1_000,
          stateEnteredAt: TIMEOUTS.lapMs - 1_000,
          currentGate: 'claim-proof',
          gates: [{ gate: 'claim-proof', enteredAt: TIMEOUTS.lapMs - 1_000, exitedAt: null }]
        }
      ]
    };
    const step = advanceLap(parked, { kind: 'tick' }, { now: TIMEOUTS.lapMs, timeouts: TIMEOUTS });
    expect(step.lap.state).toBe('LAP_FAILED');
    expect(step.lap.outcome).toBe('timeout_lap');
    expect(step.lap.hops[0]?.outcome).toBe('timeout_lap');
    expect(step.lap.hops[0]?.state).toBe('FAILED');
    expect(step.lap.hops[0]?.gates[0]?.exitedAt).toBe(TIMEOUTS.lapMs);
    // R31 (loadtest/REVIEW.md): this path used to close the open gate visit
    // in `Hop.gates` (so `results.json` was already correct) WITHOUT ever
    // emitting a `gate_exit` RingEmission — the one thing that feeds
    // `runner.ts`'s `collector.recordGateVisit` (§5.4's gate-stalls table).
    // So a gate visit interrupted by `lapMs` used to be silently absent
    // from the Gate-stalls table even though `Hop.gates` had it right.
    expect(step.emissions).toContainEqual(
      expect.objectContaining({ type: 'gate_exit', gate: 'claim-proof', timedOut: true })
    );
  });
});

describe('ring — driver-result mappers and helpers', () => {
  it('eventsFromBridge / eventsFromClaim drive a hop end to end', () => {
    const { clock, engine } = setup(0);
    let lap = engine.startLap({
      userId: 'u0',
      lapIndex: 0,
      assetIndex: 0,
      hopSpecs: [RING[2]]
    });
    const bridgeEvents: RingEvent[] = eventsFromBridge({
      allowance: null,
      approve: null,
      bridge: {
        txHash: TX_A,
        submit: { startedAt: 0, durationMs: 120 },
        receipt: { status: 'success', timing: { startedAt: 120, durationMs: 2_400 } }
      },
      depositCount: 4,
      bridgeEventFound: true
    });
    clock.set(3_000);
    lap = engine.applyAll(lap, bridgeEvents).lap;
    expect(currentHop(lap).state).toBe('AWAITING_ACTIVITY');
    expect(currentHop(lap).rowKey).toBe(`${TX_A}:4`);

    clock.set(9_000);
    lap = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 4, 'READY_TO_CLAIM')] }).lap;
    const claimEvents = eventsFromClaim({
      isClaimedBefore: false,
      isClaimedTiming: { startedAt: 9_000, durationMs: 50 },
      claimInputs: { claimable: true, timing: { startedAt: 9_050, durationMs: 900 } },
      claim: {
        txHash: CLAIM_TX,
        submit: { startedAt: 9_950, durationMs: 300 },
        receipt: { status: 'success', timing: { startedAt: 10_250, durationMs: 1_800 } }
      },
      isClaimedRecheck: null
    });
    clock.set(12_100);
    lap = engine.applyAll(lap, claimEvents).lap;
    expect(currentHop(lap).state).toBe('AWAITING_CLAIMED');
    // Driver-measured timings are what land in the §5.1 histograms.
    expect(currentHop(lap).phases).toEqual(
      expect.arrayContaining([
        { phase: 'claim_inputs', startedAt: 9_050, durationMs: 900 },
        { phase: 'claim_submit', startedAt: 9_950, durationMs: 300 },
        { phase: 'claim_receipt', startedAt: 10_250, durationMs: 1_800 }
      ])
    );
  });

  it('eventsFromBridge turns a send that never resolved into a submit_error', () => {
    const events = eventsFromBridge({
      allowance: null,
      approve: null,
      bridge: { txHash: null, submit: { startedAt: 0, durationMs: 5 }, receipt: null },
      depositCount: null,
      bridgeEventFound: false
    });
    expect(events.at(-1)).toEqual({
      kind: 'submit_error',
      step: 'bridge',
      error: { message: 'send did not resolve' }
    });
  });

  // S16/A2 (VALIDATION-1.md): a driver that fails before it can even
  // determine `claimInputs` (e.g. browser mode's clickClaim throwing) still
  // attaches its own classified `DriverError` to `submission.claim.error`.
  // `eventsFromClaim` must never drop that error just because `claimInputs`
  // itself is `null` — no `DriverError` a driver returns may ever be
  // dropped by this mapper.
  it('eventsFromClaim never drops a DriverError even when claimInputs is null', () => {
    const events = eventsFromClaim({
      isClaimedBefore: false,
      isClaimedTiming: { startedAt: 9_000, durationMs: 20 },
      claimInputs: null,
      claim: {
        txHash: null,
        submit: { startedAt: 9_020, durationMs: 30_000 },
        receipt: null,
        error: {
          message: '[claim-tokens-button] locator.click: Timeout 30000ms exceeded',
          errorClass: 'ui_assertion'
        }
      },
      isClaimedRecheck: null
    });
    expect(events).toEqual([
      { kind: 'is_claimed', claimed: false, timing: { startedAt: 9_000, durationMs: 20 } },
      {
        kind: 'submit_error',
        step: 'claim',
        error: {
          message: '[claim-tokens-button] locator.click: Timeout 30000ms exceeded',
          errorClass: 'ui_assertion'
        }
      }
    ]);
  });

  it("a claimInputs:null + claim.error submission ends the hop FAILED with the driver's own error class, never timeout_not_claimable", () => {
    const { clock, engine } = setup(0);
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: [RING[2]] });
    const bridgeEvents = eventsFromBridge({
      allowance: null,
      approve: null,
      bridge: {
        txHash: TX_A,
        submit: { startedAt: 0, durationMs: 120 },
        receipt: { status: 'success', timing: { startedAt: 120, durationMs: 2_400 } }
      },
      depositCount: 4,
      bridgeEventFound: true
    });
    clock.set(3_000);
    lap = engine.applyAll(lap, bridgeEvents).lap;
    clock.set(9_000);
    lap = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 4, 'READY_TO_CLAIM')] }).lap;
    expect(currentHop(lap).state).toBe('CLAIM_BUILD');

    const claimEvents = eventsFromClaim({
      isClaimedBefore: false,
      isClaimedTiming: { startedAt: 9_000, durationMs: 20 },
      claimInputs: null,
      claim: {
        txHash: null,
        submit: { startedAt: 9_020, durationMs: 30_000 },
        receipt: null,
        error: {
          message: '[claim-tokens-button] locator.click: Timeout 30000ms exceeded',
          errorClass: 'ui_assertion'
        }
      },
      isClaimedRecheck: null
    });
    clock.set(39_050);
    lap = engine.applyAll(lap, claimEvents).lap;

    expect(currentHop(lap).state).toBe('FAILED');
    expect(currentHop(lap).outcome).toBe('ui_assertion');
    expect(currentHop(lap).outcome).not.toBe('timeout_not_claimable');
  });

  it('gateFromClaimInputsReason branches with a default (the reason union is OPEN)', () => {
    expect(gateFromClaimInputsReason('SOURCE_NOT_ON_L1_INFO_TREE')).toBe('l1-info-tree-index');
    expect(gateFromClaimInputsReason('SYNCER_INCONSISTENT')).toBe('syncer-inconsistent');
    expect(gateFromClaimInputsReason('DESTINATION_NOT_INJECTED')).toBe('injected-l1-info-leaf');
    expect(gateFromClaimInputsReason('SOMETHING_THE_SDK_ADDED_LATER')).toBe('claim-proof');
    expect(gateFromClaimInputsReason(undefined)).toBe('claim-proof');
  });

  it('nextAction tells the runner exactly one thing to do per state', () => {
    expect(nextAction(hopInState('PLANNED'))).toEqual({ kind: 'bridge' });
    expect(nextAction(hopInState('BRIDGE_PENDING'))).toEqual({ kind: 'awaiting_driver' });
    expect(nextAction(hopInState('AWAITING_READY'))).toEqual({ kind: 'observe_activity' });
    expect(nextAction(hopInState('CLAIM_BUILD', { claimStep: 'is_claimed' }))).toEqual({
      kind: 'claim'
    });
    expect(nextAction(hopInState('CLAIM_BUILD', { claimStep: 'submit' }))).toEqual({
      kind: 'awaiting_driver'
    });
    expect(nextAction(hopInState('DONE'))).toEqual({ kind: 'none' });
  });

  it('a terminal hop absorbs further events without changing (idempotent)', () => {
    const done = hopInState('DONE', { outcome: 'hop_completed_auto' });
    const step = advanceHop(done, { kind: 'tick' }, { now: 10_000_000, timeouts: TIMEOUTS });
    expect(step.hop).toBe(done);
    expect(step.emissions).toEqual([]);
  });

  it('gate visits are opened and closed so §5.4 can total the stalls', () => {
    const { clock, engine } = setup(0);
    let lap = engine.startLap({ userId: 'u0', lapIndex: 0, assetIndex: 0, hopSpecs: RING });
    lap = bridgeOk(lap, engine, clock, TX_A, 1);
    const enteredActivityAt = clock.now();
    clock.advance(7_000);
    lap = engine.apply(lap, { kind: 'activity', rows: [makeRow(TX_A, 1, 'READY_TO_CLAIM')] }).lap;
    const hop = currentHop(lap);
    expect(hop.gates[0]).toEqual({
      gate: 'activity-index',
      enteredAt: enteredActivityAt,
      exitedAt: enteredActivityAt + 7_000
    });
    // AWAITING_READY's `claim-proof` visit is opened and closed in the same
    // poll (the row was already READY_TO_CLAIM), then `claimed` opens.
    expect(hop.gates.map((visit) => visit.gate)).toEqual([
      'activity-index',
      'claim-proof',
      'claimed'
    ]);
    expect(hop.currentGate).toBe('claimed');
  });
});
