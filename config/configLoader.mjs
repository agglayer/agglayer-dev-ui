import { parseConfigOrThrow } from './configValidator.mjs';

/**
 * @typedef {import('./configValidator.mjs').JsonConfig} JsonConfig
 */

/**
 * Resolves one origin-relative aggkit base URL. Absolute values pass through
 * unchanged. See design.md §5.4 for the precedence rules encoded here.
 *
 * @param {string} value
 * @param {string | undefined} origin
 * @param {boolean} allowRelative
 * @returns {string}
 */
export const resolveAggkitBridgeApiUrl = (value, origin, allowRelative) => {
  if (!value.startsWith('/')) return value;

  // Protocol-relative ("//host/path") is rejected here as well as in
  // config/configSchema.mjs's relativeUrlPath regex. The schema is the primary
  // guard, but this function is exported and is also called directly from
  // app/config.ts's NEXT_PUBLIC_AGGKIT_BRIDGE_APIS path, so the same-origin
  // property should not depend on every caller having validated first. It
  // matters specifically on the `allowRelative && origin === undefined` branch
  // below, which returns the value verbatim: `new URL('//evil.example',
  // 'https://app.example').origin` is `https://evil.example`, so an
  // unprefixed protocol-relative value is a cross-origin request, not a
  // relative one. (When an origin IS supplied the concatenation below is
  // already safe — `https://app.example` + `//evil.example` parses as a path.)
  if (value.startsWith('//')) {
    throw new Error(
      `APP_CONFIG_INVALID: protocol-relative aggkitBridgeApis URL "${value}" is not allowed`
    );
  }

  if (origin === undefined) {
    if (allowRelative) return value;
    throw new Error(
      `APP_CONFIG_INVALID: relative aggkitBridgeApis URL "${value}" requires an origin`
    );
  }

  return origin.replace(/\/+$/, '') + value;
};

/**
 * Resolves both aggkit URL fields a mode config may carry: the per-network
 * `aggkitBridgeApis` map (unchanged behavior) and the single `aggkitProxy`
 * string (new). At most one is actually present per configSchema.mjs's
 * mutual-exclusion check, but both are handled uniformly here rather than
 * branching on which form this mode uses -- `aggkitBridgeApis` defaults to
 * `{}` when absent (the "not configured" escape hatch, or a mode using
 * `aggkitProxy` instead) so every mode config coming out of this function has
 * a concrete (possibly empty) map, matching JsonAppModeConfig's shape before
 * this normalization pass ran.
 *
 * @param {JsonConfig['appModes']['configs'][string]} modeConfig
 * @param {string | undefined} origin
 * @param {boolean} allowRelative
 * @returns {JsonConfig['appModes']['configs'][string]}
 */
const resolveModeConfigAggkitUrls = (modeConfig, origin, allowRelative) => {
  const resolvedAggkitBridgeApis = Object.fromEntries(
    Object.entries(modeConfig.aggkitBridgeApis ?? {}).map(([networkIdKey, value]) => [
      networkIdKey,
      resolveAggkitBridgeApiUrl(value, origin, allowRelative)
    ])
  );

  return {
    ...modeConfig,
    aggkitBridgeApis: resolvedAggkitBridgeApis,
    ...(modeConfig.aggkitProxy === undefined
      ? {}
      : { aggkitProxy: resolveAggkitBridgeApiUrl(modeConfig.aggkitProxy, origin, allowRelative) })
  };
};

/**
 * @param {JsonConfig} config
 * @param {string | undefined} origin
 * @param {boolean} allowRelative
 * @returns {JsonConfig}
 */
const resolveAggkitBridgeApisInConfig = (config, origin, allowRelative) => {
  const resolvedConfigs = Object.fromEntries(
    Object.entries(config.appModes.configs).map(([modeKey, modeConfig]) => [
      modeKey,
      resolveModeConfigAggkitUrls(modeConfig, origin, allowRelative)
    ])
  );

  return {
    ...config,
    appModes: {
      ...config.appModes,
      configs: resolvedConfigs
    }
  };
};

/**
 * The single validate-and-normalize path shared by every loader (browser
 * fetch adapter, Node disk adapter, Playwright bootstrap, sync/validate
 * scripts). Schema-valid AND URL-normalized on return. Never mutates its
 * input. Zero Node APIs — safe to bundle client-side.
 *
 * @param {unknown} rawConfig
 * @param {{ sourceName?: string, origin?: string, allowRelative?: boolean }} [options]
 * @returns {JsonConfig}
 */
export const normalizeConfigOrThrow = (rawConfig, options = {}) => {
  const { sourceName, origin, allowRelative = false } = options;
  const parsedConfig = parseConfigOrThrow(rawConfig, { sourceName });
  return resolveAggkitBridgeApisInConfig(parsedConfig, origin, allowRelative);
};
