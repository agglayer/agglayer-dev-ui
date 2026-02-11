import type { Address, Hex } from 'viem';

export const normalizeEnvValue = (value: string | undefined): string => (value ?? '').replace(/^['"]|['"]$/g, '').trim();

export const isHexPrivateKey = (value: string): value is Hex => /^0x[0-9a-fA-F]{64}$/.test(value);

export const isHexAddress = (value: string): value is Address => /^0x[0-9a-fA-F]{40}$/.test(value);
