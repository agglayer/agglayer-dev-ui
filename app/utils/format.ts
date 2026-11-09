import type BigNumber from 'bignumber.js';

import { bn, toNumber } from './bigNumber';

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
        maximumFractionDigits: 6
      });
      return `${prefix} ${thresholdStr}`;
    }

    const num = toNumber(value);
    return num.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6
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

const MAX_ERROR_SUMMARY_LENGTH = 200;

// Short, single-line, tag-free summary of an unknown error for UI tooltips:
// a failed RPC call can carry a whole HTML page (e.g. a Cloudflare block) as its message.
export const summarizeError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'Unknown error';
  return text.length > MAX_ERROR_SUMMARY_LENGTH
    ? `${text.slice(0, MAX_ERROR_SUMMARY_LENGTH)}…`
    : text;
};
