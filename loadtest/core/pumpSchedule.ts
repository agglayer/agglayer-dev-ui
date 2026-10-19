// The L1 deposit pump's tick decision (S53, heavy-load design §1.3) — pure and
// clock-agnostic like the rest of `core/`: everything it needs arrives as an
// argument (`now` included), so a fake clock can walk the whole schedule.
// `workers/pump/l1Pump.ts` owns the I/O (gas price, estimate, send, receipt)
// and feeds this function; this file owns WHEN the pump fires, pauses or stops.
//
// Money values are wei `bigint`s.

export interface PumpScheduleConfig {
  /** `pump.intervalSeconds` in ms. */
  intervalMs: number;
  /** Hard spend cap for the whole run. */
  maxTotalSpendWei: bigint;
  /** Pause threshold AND the `maxFeePerGas` of every pump tx, so a sent tx can never pay more. */
  maxGasPriceWei: bigint;
  /** Value sent with each deposit (0 by default — the bridge accepts it, no dust). */
  amountWei: bigint;
}

export interface PumpTickInput {
  now: number;
  /** When the previous tick was evaluated (`null`: the pump has not ticked yet). */
  lastTickAt: number | null;
  /** A pump tx has been sent and has no receipt yet. */
  pending: boolean;
  /**
   * Actual spend of every settled deposit PLUS the worst case of a still-pending
   * one — a pending tx is counted as if it will cost everything it is allowed to.
   */
  committedWei: bigint;
  gasPriceWei: bigint;
  gasEstimate: bigint;
}

export type PumpSkipReason = 'previous_pending' | 'gas_price';

export type PumpDecision =
  | { kind: 'wait'; msUntilDue: number }
  | { kind: 'fire'; gasLimit: bigint; worstCaseWei: bigint }
  | { kind: 'skip'; reason: PumpSkipReason }
  | { kind: 'stop'; reason: 'cap_reached' };

/** The gas limit sent with a deposit: the live estimate plus a 20 % margin. */
export const pumpGasLimit = (gasEstimate: bigint): bigint =>
  (gasEstimate * BigInt(12)) / BigInt(10);

/** Most a single deposit can cost: `gasLimit x maxFeePerGas + amount`. */
export const pumpWorstCaseWei = (config: PumpScheduleConfig, gasEstimate: bigint): bigint =>
  pumpGasLimit(gasEstimate) * config.maxGasPriceWei + config.amountWei;

/** ms until the next tick is due (`0` = due now; the first tick is due immediately). */
export const pumpMsUntilDue = (
  config: Pick<PumpScheduleConfig, 'intervalMs'>,
  lastTickAt: number | null,
  now: number
): number => (lastTickAt === null ? 0 : Math.max(0, lastTickAt + config.intervalMs - now));

/**
 * Fires at the first tick, then once per interval. Within a due tick, in order:
 *  1. `previous_pending`: a pump tx has no receipt yet (only ever one in flight,
 *     so there is no nonce race);
 *  2. `gas_price`: the L1 gas price is above `maxGasPriceWei` (the pump pauses
 *     and simply re-evaluates at the next tick, so it resumes by itself);
 *  3. `stop(cap_reached)`: `committed + worst case of this deposit` would exceed
 *     `maxTotalSpendWei` — final, the pump sends nothing more this run;
 *  otherwise `fire`.
 * A tick that is not yet due answers `wait` and changes nothing.
 */
export const decidePumpTick = (config: PumpScheduleConfig, input: PumpTickInput): PumpDecision => {
  const msUntilDue = pumpMsUntilDue(config, input.lastTickAt, input.now);
  if (msUntilDue > 0) return { kind: 'wait', msUntilDue };
  if (input.pending) return { kind: 'skip', reason: 'previous_pending' };
  if (input.gasPriceWei > config.maxGasPriceWei) return { kind: 'skip', reason: 'gas_price' };
  const worstCaseWei = pumpWorstCaseWei(config, input.gasEstimate);
  if (input.committedWei + worstCaseWei > config.maxTotalSpendWei) {
    return { kind: 'stop', reason: 'cap_reached' };
  }
  return { kind: 'fire', gasLimit: pumpGasLimit(input.gasEstimate), worstCaseWei };
};
