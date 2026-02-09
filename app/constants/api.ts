const bridgeHubApiBaseUrl = process.env.NEXT_PUBLIC_BRIDGE_HUB_API?.trim();

if (!bridgeHubApiBaseUrl) {
  throw new Error('NEXT_PUBLIC_BRIDGE_HUB_API is required');
}

export const BRIDGE_HUB_API_BASE_URL = bridgeHubApiBaseUrl.replace(/\/+$/, '');
