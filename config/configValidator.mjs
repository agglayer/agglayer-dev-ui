import { APP_MODES } from './appModes.mjs';
import { jsonConfigSchema } from './configSchema.mjs';

const APP_MODE_SET = new Set(APP_MODES);
const MIN_ENABLED_MODE_CHAIN_COUNT = 2;
const DEFAULT_CHAIN_KEY_FIELDS = /** @type {const} */ ([
  'defaultFromChainKey',
  'defaultToChainKey'
]);

/**
 * @typedef {import('zod').infer<typeof jsonConfigSchema>} JsonConfig
 */

/**
 * @param {Array<string | number | symbol>} pathSegments
 * @returns {string}
 */
const formatZodPath = (pathSegments) => {
  if (!pathSegments.length) return 'config';
  return pathSegments
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : String(segment)))
    .join('.');
};

/**
 * @param {JsonConfig['chains']} chainsByKey
 * @returns {string[]}
 */
const getDuplicateChainIdErrors = (chainsByKey) => {
  const firstChainKeyById = new Map();

  return Object.entries(chainsByKey).flatMap(([chainKey, chainConfig]) => {
    const existingChainKey = firstChainKeyById.get(chainConfig.id);
    if (existingChainKey) {
      return [
        `chains.${chainKey}.id: duplicate chain id "${chainConfig.id}" (already used by "${existingChainKey}")`
      ];
    }

    firstChainKeyById.set(chainConfig.id, chainKey);
    return [];
  });
};

/**
 * @param {JsonConfig['appModes']['configs']} modeConfigsByKey
 * @returns {string[]}
 */
const getUnsupportedModeKeyErrors = (modeConfigsByKey) =>
  Object.keys(modeConfigsByKey)
    .filter((modeKey) => !APP_MODE_SET.has(modeKey))
    .map(
      (modeKey) =>
        `appModes.configs.${modeKey}: unsupported mode key; expected one of ${APP_MODES.join(', ')}`
    );

/**
 * @param {string} modeKey
 * @param {JsonConfig['appModes']['configs'][string]} modeConfig
 * @param {JsonConfig['chains']} chainsByKey
 * @returns {string[]}
 */
const getModeConfigErrors = (modeKey, modeConfig, chainsByKey) => {
  const modeChainKeySet = new Set(modeConfig.chainKeys);

  const duplicateModeChainKeyErrors =
    modeChainKeySet.size !== modeConfig.chainKeys.length
      ? [`appModes.configs.${modeKey}.chainKeys: duplicate chain keys are not allowed`]
      : [];

  const missingModeChainKeyErrors = modeConfig.chainKeys
    .filter((chainKey) => !chainsByKey[chainKey])
    .map(
      (chainKey) =>
        `appModes.configs.${modeKey}.chainKeys: chain key "${chainKey}" does not exist in chains`
    );

  const invalidDefaultChainKeyErrors = DEFAULT_CHAIN_KEY_FIELDS.flatMap((fieldName) => {
    const configuredChainKey = modeConfig[fieldName];
    if (!configuredChainKey || modeChainKeySet.has(configuredChainKey)) return [];
    return [
      `appModes.configs.${modeKey}.${fieldName}: "${configuredChainKey}" must be listed in chainKeys`
    ];
  });

  return [
    ...duplicateModeChainKeyErrors,
    ...missingModeChainKeyErrors,
    ...invalidDefaultChainKeyErrors,
    ...getChainsAggkitBridgeApiErrors(modeKey, modeConfig, chainsByKey)
  ];
};

/**
 * design.md §1.2: a mode's `aggkitBridgeApis` and its `chainKeys` must agree on
 * which non-L1 (networkId !== 0) networks exist, so a bad devnet-script run or a
 * hand-edit can't silently produce "3 chains configured, 1 backend, the third
 * chain's rows never appear and nothing says why". `aggkitBridgeApis: {}` (or the
 * key omitted entirely) is the documented "mode not yet configured" escape hatch
 * (configSchema.mjs's own comment) and is exempt from every check below --
 * as is a mode using `aggkitProxy` instead (configSchema.mjs's superRefine
 * guarantees the two are never both present): a single proxy fronts every
 * network in the mode by construction, so per-chain key agreement is
 * meaningless for it -- which is exactly why devnet's per-network map used to
 * duplicate one URL under every networkId key instead of using this field.
 *
 * The duplicate-networkId check closes the same gap reached from the other side.
 * `networkId` — not the chain id — is what keys `aggkitBridgeApis` and what the
 * SDK aggregator keys its per-network clients by, so two chains sharing one
 * networkId collapse to a single backend client and one chain's rows silently
 * merge into the other's. The key-agreement checks alone do not catch it: with
 * DEVNET_L2_001 and DEVNET_L2_002 both on networkId 1 and a single `{"1": url}`
 * entry, every chain finds a matching key and every key matches some chain.
 * `scripts/kurtosisDevnetEnv.mjs` derives networkId from the kurtosis
 * deployment suffix, a convention rather than a protocol guarantee (design.md
 * §9 risk 7), so a mis-derivation is exactly how this shape would arise.
 *
 * @param {string} modeKey
 * @param {JsonConfig['appModes']['configs'][string]} modeConfig
 * @param {JsonConfig['chains']} chainsByKey
 * @returns {string[]}
 */
const getChainsAggkitBridgeApiErrors = (modeKey, modeConfig, chainsByKey) => {
  // Undefined (field omitted) and {} are both the "not configured" escape
  // hatch; a mode using aggkitProxy instead always lands here too, since
  // configSchema.mjs's superRefine guarantees aggkitBridgeApis is then absent
  // or empty -- this whole check is map-form-only (see the comment above).
  const aggkitBridgeApis = modeConfig.aggkitBridgeApis ?? {};
  const isIntentionallyUnconfigured = Object.keys(aggkitBridgeApis).length === 0;
  if (isIntentionallyUnconfigured) return [];

  // Chains missing from chainsByKey are already reported by
  // missingModeChainKeyErrors above; skip them here rather than double-report.
  const nonL1ChainEntries = modeConfig.chainKeys
    .filter((chainKey) => chainsByKey[chainKey] && chainsByKey[chainKey].networkId !== 0)
    .map((chainKey) => ({ chainKey, networkId: chainsByKey[chainKey].networkId }));

  const missingApiEntryErrors = nonL1ChainEntries
    .filter(({ networkId }) => !(String(networkId) in aggkitBridgeApis))
    .map(
      ({ chainKey, networkId }) =>
        `appModes.configs.${modeKey}.aggkitBridgeApis: missing entry for chain "${chainKey}" (networkId ${networkId})`
    );

  const configuredNetworkIdKeys = new Set(
    nonL1ChainEntries.map(({ networkId }) => String(networkId))
  );
  const unmatchedApiKeyErrors = Object.keys(aggkitBridgeApis)
    .filter((networkIdKey) => !configuredNetworkIdKeys.has(networkIdKey))
    .map(
      (networkIdKey) =>
        `appModes.configs.${modeKey}.aggkitBridgeApis: key "${networkIdKey}" does not match the networkId of any chain in chainKeys`
    );

  const firstChainKeyByNetworkId = new Map();
  const duplicateNetworkIdErrors = nonL1ChainEntries.flatMap(({ chainKey, networkId }) => {
    const existingChainKey = firstChainKeyByNetworkId.get(networkId);
    if (existingChainKey) {
      return [
        `appModes.configs.${modeKey}.chainKeys: chains "${existingChainKey}" and "${chainKey}" share networkId ${networkId}; each network needs a distinct networkId to get its own aggkitBridgeApis backend`
      ];
    }

    firstChainKeyByNetworkId.set(networkId, chainKey);
    return [];
  });

  return [...missingApiEntryErrors, ...unmatchedApiKeyErrors, ...duplicateNetworkIdErrors];
};

/**
 * @param {JsonConfig} config
 * @returns {string[]}
 */
const validateSemantics = (config) => {
  const chainKeys = Object.keys(config.chains);
  const modeConfigsByKey = config.appModes.configs;

  const noChainsError = chainKeys.length ? [] : ['chains: configure at least one chain'];
  const duplicateChainIdErrors = getDuplicateChainIdErrors(config.chains);
  const unsupportedModeKeyErrors = getUnsupportedModeKeyErrors(modeConfigsByKey);

  const hasEnabledMode = APP_MODES.some((modeKey) => {
    const modeConfig = modeConfigsByKey[modeKey];
    return Boolean(modeConfig && modeConfig.chainKeys.length >= MIN_ENABLED_MODE_CHAIN_COUNT);
  });
  const missingEnabledModeError = hasEnabledMode
    ? []
    : ['appModes.configs: configure at least one mode with two or more chainKeys'];

  const missingDefaultModeConfigError = modeConfigsByKey[config.appModes.default]
    ? []
    : [`appModes.configs.${config.appModes.default}: missing config for default mode`];

  const modeConfigErrors = APP_MODES.flatMap((modeKey) => {
    const modeConfig = modeConfigsByKey[modeKey];
    if (!modeConfig) return [];
    return getModeConfigErrors(modeKey, modeConfig, config.chains);
  });

  return [
    ...noChainsError,
    ...duplicateChainIdErrors,
    ...unsupportedModeKeyErrors,
    ...missingEnabledModeError,
    ...missingDefaultModeConfigError,
    ...modeConfigErrors
  ];
};

/**
 * @param {unknown} configJson
 * @param {{ sourceName?: string }} [options]
 * @returns {JsonConfig}
 */
export const parseConfigOrThrow = (configJson, options = {}) => {
  const sourceName = options.sourceName ?? 'config';
  const parsedConfig = jsonConfigSchema.safeParse(configJson);
  if (!parsedConfig.success) {
    const lines = parsedConfig.error.issues.map((issue) => {
      const issuePath = formatZodPath(issue.path);
      return `${issuePath}: ${issue.message}`;
    });
    throw new Error(
      `${sourceName} schema validation failed:\n${lines.map((line) => `- ${line}`).join('\n')}`
    );
  }

  const semanticErrors = validateSemantics(parsedConfig.data);
  if (semanticErrors.length > 0) {
    throw new Error(
      `${sourceName} semantic validation failed:\n${semanticErrors.map((line) => `- ${line}`).join('\n')}`
    );
  }

  return parsedConfig.data;
};
