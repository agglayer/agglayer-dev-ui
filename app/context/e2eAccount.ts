import { privateKeyToAccount } from 'viem/accounts';
import { E2E_PRIVATE_KEY, E2E_WALLET_ADDRESS, IS_E2E_ENABLED } from '@/app/constants/e2e';

const e2eLocalAccount = IS_E2E_ENABLED && E2E_PRIVATE_KEY ? privateKeyToAccount(E2E_PRIVATE_KEY) : undefined;
const e2eWalletAddress = IS_E2E_ENABLED ? E2E_WALLET_ADDRESS : undefined;

export { e2eLocalAccount, e2eWalletAddress };
