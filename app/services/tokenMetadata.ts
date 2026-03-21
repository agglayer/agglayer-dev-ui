import { AppMode } from '@/app/types/appMode';
import { getProofApiBaseUrl } from '@/app/utils/appMode';
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
  status: string;
  data?: TokenMetadata;
  error?: string;
}

export const fetchTokenMetadata = async (mode: AppMode, tokenAddress: string): Promise<TokenMetadata> => {
  const url = `${getProofApiBaseUrl(mode)}/token-metadata/${normalize(tokenAddress)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`TOKEN_METADATA_${res.status}: ${msg || 'Request failed'}`);
  }

  const json: TokenMetadataResponse = await res.json();

  if (json.status !== 'success' || !json.data) {
    throw new Error(json.error || 'TOKEN_METADATA_INVALID_RESPONSE');
  }

  const { data } = json;
  const requestedAddress = normalize(tokenAddress);
  const matchedAddress = [
    data.tokenAddress,
    data.originTokenAddress,
    data.wrappedTokenAddressV1,
    data.wrappedTokenAddressV2,
  ].find((addr) => addr && normalize(addr) === requestedAddress);

  if (!matchedAddress) {
    throw new Error('TOKEN_METADATA_MISSING_ADDRESS');
  }

  return {
    ...data,
    tokenAddress: matchedAddress,
    decimals: Number(data.decimals),
  };
};
