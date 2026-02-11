import { isHexAddress, isHexPrivateKey, normalizeEnvValue } from '@/app/utils/e2eEnv';
import type { AppMode } from '@/app/types/appMode';
import type { Address, Hex } from 'viem';

export const IS_E2E_ENABLED = process.env.NEXT_PUBLIC_E2E_ENABLED === 'true';
export const E2E_APP_MODE: AppMode = 'testnet';

const resolvedPrivateKey = normalizeEnvValue(process.env.NEXT_PUBLIC_E2E_PRIVATE_KEY);
const resolvedWalletAddress = normalizeEnvValue(process.env.NEXT_PUBLIC_E2E_WALLET_ADDRESS);

if (IS_E2E_ENABLED && !isHexPrivateKey(resolvedPrivateKey)) {
  throw new Error(
    'E2E private key is invalid. NEXT_PUBLIC_E2E_PRIVATE_KEY must be a valid private key.',
  );
}

if (IS_E2E_ENABLED && !isHexAddress(resolvedWalletAddress)) {
  throw new Error('E2E wallet address is invalid. Set NEXT_PUBLIC_E2E_WALLET_ADDRESS to a valid address.');
}

export const E2E_PRIVATE_KEY = IS_E2E_ENABLED ? (resolvedPrivateKey as Hex) : undefined;
export const E2E_WALLET_ADDRESS = IS_E2E_ENABLED ? (resolvedWalletAddress as Address) : undefined;
export const E2E_ERC20_ADDRESS: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
export const E2E_ERC20_SYMBOL = 'USDC';
export const E2E_ERC20_NAME = 'USD Coin';
export const E2E_ERC20_DECIMALS = 6;
export const E2E_FROM_CHAIN_ID = 11155111;
export const E2E_NATIVE_BRIDGE_AMOUNT = '0.00001';
export const E2E_ERC20_BRIDGE_AMOUNT = '0.01';
