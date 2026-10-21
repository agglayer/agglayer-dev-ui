import type { JsonConfig } from '@/app/types/config';

import { normalizeConfigOrThrow } from '@/config/configLoader.mjs';

// Root-absolute path. Documented limitation: this assumes the app is served
// at origin root (matches docs/deployment.md and wrangler.toml — next.config.ts
// sets no basePath). If one is ever added, this constant must be prefixed.
export const APP_CONFIG_URL = '/config.json';

/**
 * Fetches and validates the runtime config served alongside this build.
 * Each failure mode produces a distinguishable message (see A-1 design §4.2):
 * non-OK HTTP, non-JSON body, schema violation, semantic violation, network
 * error. Uses `cache: 'no-store'` as defence in depth alongside nginx's
 * `Cache-Control: no-store` (R7), so a browser cache hit can never serve a
 * previous container's config after a restart.
 */
export const fetchAppConfig = async (options?: {
  url?: string;
  origin?: string;
}): Promise<JsonConfig> => {
  const url = options?.url ?? APP_CONFIG_URL;
  const origin = options?.origin ?? window.location.origin;

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`APP_CONFIG_FETCH_FAILED: GET ${url} failed: ${cause}`);
  }

  if (!response.ok) {
    throw new Error(
      `APP_CONFIG_FETCH_FAILED: GET ${url} returned ${response.status} ${response.statusText}`
    );
  }

  const bodyText = await response.text();

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(bodyText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown JSON parse error';
    throw new Error(`APP_CONFIG_INVALID: ${url} is not valid JSON: ${message}`);
  }

  return normalizeConfigOrThrow(rawConfig, { sourceName: 'config.json', origin }) as JsonConfig;
};
