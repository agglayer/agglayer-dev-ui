import { privateKeyToAccount } from 'viem/accounts';
import { isHexPrivateKey, normalizeEnvValue } from '@/app/utils/e2eEnv';
import type { Address, Hex } from 'viem';

export const IS_E2E_ENABLED = process.env.NEXT_PUBLIC_E2E_ENABLED === 'true';

const resolvedPrivateKey = normalizeEnvValue(process.env.NEXT_PUBLIC_E2E_PRIVATE_KEY);

if (IS_E2E_ENABLED && !isHexPrivateKey(resolvedPrivateKey)) {
  throw new Error(
    'E2E private key is invalid. NEXT_PUBLIC_E2E_PRIVATE_KEY must be a valid private key.',
  );
}

export const E2E_PRIVATE_KEY = IS_E2E_ENABLED ? (resolvedPrivateKey as Hex) : undefined;
export const E2E_WALLET_ADDRESS: Address | undefined = E2E_PRIVATE_KEY
  ? privateKeyToAccount(E2E_PRIVATE_KEY).address
  : undefined;
export const E2E_ERC20_ADDRESS: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
export const E2E_FROM_CHAIN_ID = 11155111;
export const E2E_NATIVE_BRIDGE_AMOUNT = '0.00001';
export const E2E_ERC20_BRIDGE_AMOUNT = '0.01';
