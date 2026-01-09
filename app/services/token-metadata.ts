import { appConfig } from '@/app/config';
import { isTestnetChain } from '@/app/utils/network';
import { normalize } from '@/app/utils/format';

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  tokenAddress: string;
  network?: number | string;
  totalSupply?: string;
  logoURI?: string;
  originTokenAddress?: string;
  originTokenNetwork?: number | string;
  wrappedTokenAddressV1?: string;
  wrappedTokenAddressV2?: string;
}

interface TokenMetadataResponse {
  status?: string;
  success?: boolean;
  data?: TokenMetadata;
  error?: string;
}

const buildTokenMetadataUrl = (chainId: number, tokenAddress: string) => {
  const origin = appConfig.BRIDGE_HUB_API;
  if (!origin) {
    throw new Error('BRIDGE_HUB_API missing');
  }
  const network = isTestnetChain(chainId) ? 'testnet' : 'mainnet';
  return `${origin}/${network}/token-metadata/${normalize(tokenAddress)}`;
};

export const fetchTokenMetadata = async (chainId: number, tokenAddress: string): Promise<TokenMetadata> => {
  const url = buildTokenMetadataUrl(chainId, tokenAddress);
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`TOKEN_METADATA_${res.status}: ${msg || 'Request failed'}`);
  }

  const json: TokenMetadataResponse = await res.json();

  const isSuccess = json.success === true || json.status === 'success';
  if (!isSuccess || !json.data) {
    throw new Error(json.error || 'TOKEN_METADATA_INVALID_RESPONSE');
  }

  const data = json.data;
  const resolvedAddress = data.tokenAddress ?? data.originTokenAddress;
  if (!resolvedAddress) {
    throw new Error('TOKEN_METADATA_MISSING_ADDRESS');
  }

  return {
    ...data,
    tokenAddress: resolvedAddress,
    decimals: Number(data.decimals),
  };
};
