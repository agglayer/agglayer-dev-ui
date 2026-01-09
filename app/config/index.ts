export const appConfig = {
  BALANCE_API_MAINNET_URL: process.env.NEXT_PUBLIC_BALANCE_API_MAINNET || '',
  BALANCE_API_TESTNET_URL: process.env.NEXT_PUBLIC_BALANCE_API_TESTNET || '',
  BRIDGE_HUB_API: process.env.NEXT_PUBLIC_BRIDGE_HUB_API || '',
} as const;
