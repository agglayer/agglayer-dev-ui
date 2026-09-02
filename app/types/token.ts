export interface Token {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
  logoURI?: string;
  isNative?: boolean;
  isCustom?: boolean;
  // Only set on a native-currency Token, from AppChain.nativeCurrency.wethToken
  // -- the AggLayer bridge contract's own WETHToken address on a network
  // whose native/gas token isn't ether (see config/configSchema.mjs's
  // wethToken comment). When present and non-zero,
  // app/hooks/useTokenBalance.ts reads the displayed balance from this
  // ERC-20 instead of the native balance, and app/hooks/useBridgeExecution.ts
  // uses it as the bridgeAsset `token` param instead of the zero address.
  wethToken?: string;
}
