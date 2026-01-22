import BigNumber from 'bignumber.js';
import { formatUnits, parseUnits } from 'viem';

// Configure BigNumber for DeFi precision requirements
BigNumber.config({
  DECIMAL_PLACES: 18,
  EXPONENTIAL_AT: [-18, 20],
});

type NumericInput = string | number | BigNumber;

/**
 * Safe BigNumber constructor with fallback to zero
 */
export function bn(value: NumericInput): BigNumber {
  try {
    return new BigNumber(value);
  } catch {
    return new BigNumber(0);
  }
}

/**
 * Convert wei/base units to human readable BigNumber
 */
export function fromWei(amount: string | bigint, decimals: number): BigNumber {
  const amountStr = typeof amount === 'bigint' ? amount.toString() : amount;
  const formatted = formatUnits(BigInt(amountStr), decimals);
  return bn(formatted);
}

/**
 * Convert human readable amount to wei/base units
 */
export function toWei(amount: NumericInput, decimals: number): bigint {
  const value = bn(amount);
  if (!value.isFinite()) return BigInt(0);
  return parseUnits(value.toFixed(), decimals);
}

/**
 * parse a value into bigint or fallback to null
 */
export function safeParseBigInt(value: string | number | bigint | null | undefined): bigint | null {
  if (value == null) return null;
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Calculate USD value of token amount
 */
export function toUSD(amount: NumericInput, price: NumericInput, decimals?: number): BigNumber {
  const tokenAmount = decimals ? fromWei(amount.toString(), decimals) : bn(amount);
  return tokenAmount.multipliedBy(bn(price));
}

/**
 * Check if amount is positive (> 0)
 */
export function isPositive(value: NumericInput): boolean {
  const num = bn(value);
  return num.isPositive() && !num.isZero();
}

/**
 * Check if first value >= second value
 */
export function gte(a: NumericInput, b: NumericInput): boolean {
  return bn(a).isGreaterThanOrEqualTo(bn(b));
}

/**
 * Convert BigNumber to number (use with caution for precision)
 */
export function toNumber(value: BigNumber): number {
  if (!value.isFinite()) return 0;
  return value.toNumber();
}
