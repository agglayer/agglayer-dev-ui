import type BigNumber from 'bignumber.js';
import { bn, toNumber } from './big-number';

export const normalize = (value: string) => value.trim().toLowerCase();

const MIN_DISPLAY_THRESHOLD = 1e-6;

export const formatTokenAmount = (amount: number | string | BigNumber) => {
  try {
    const value = bn(amount);
    if (!value.isFinite()) return '-';

    // stop numbers rounding down to 0 and instead show < 0.000001 or > -0.000001
    const absoluteValue = value.absoluteValue();
    if (absoluteValue.isZero()) return '0';

    if (absoluteValue.isLessThan(MIN_DISPLAY_THRESHOLD)) {
      const isNegative = value.isNegative();
      const prefix = isNegative ? '>' : '<';
      const threshold = isNegative ? -MIN_DISPLAY_THRESHOLD : MIN_DISPLAY_THRESHOLD;
      const thresholdStr = threshold.toLocaleString(undefined, {
        minimumFractionDigits: 6,
        maximumFractionDigits: 6,
      });
      return `${prefix} ${thresholdStr}`;
    }

    const num = toNumber(value);
    return num.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    });
  } catch {
    return '-';
  }
};

export const toBigInt = (value?: string) => {
  if (!value) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
};
