export interface Token {
  chainId: number;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
  logoURI?: string;
  isNative?: boolean;
  isCustom?: boolean;
  // Set on a Token derived (not added by the user): the wrapped version, on
  // `chainId`, of a user-added token. `sourceToken` identifies that user-added
  // token by its origin chain + address (see app/context/token.tsx).
  isComputed?: boolean;
  sourceToken?: { chainId: number; address: string };
  // Only set on a native-currency Token, from AppChain.nativeCurrency.wethToken
  // -- the AggLayer bridge contract's own WETHToken address on a network
  // whose native/gas token isn't ether (see config/configSchema.mjs's
  // wethToken comment). When present and non-zero,
  // app/hooks/useTokenBalance.ts reads the displayed balance from this
  // ERC-20 instead of the native balance, and app/hooks/useBridgeExecution.ts
  // uses it as the bridgeAsset `token` param instead of the zero address.
  wethToken?: string;
}
