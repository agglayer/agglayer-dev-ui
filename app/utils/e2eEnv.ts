import type { Hex } from 'viem';

export const normalizeEnvValue = (value: string | undefined): string =>
  (value ?? '').replace(/^['"]|['"]$/g, '').trim();

export const isHexPrivateKey = (value: string): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value);
