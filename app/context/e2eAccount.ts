import { E2E_PRIVATE_KEY, IS_E2E_ENABLED } from '@/app/constants/e2e';
import { privateKeyToAccount } from 'viem/accounts';

const e2eLocalAccount =
  IS_E2E_ENABLED && E2E_PRIVATE_KEY ? privateKeyToAccount(E2E_PRIVATE_KEY) : undefined;
const e2eWalletAddress = e2eLocalAccount?.address;

export { e2eLocalAccount, e2eWalletAddress };
