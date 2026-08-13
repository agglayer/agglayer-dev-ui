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
    ...invalidDefaultChainKeyErrors
  ];
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
