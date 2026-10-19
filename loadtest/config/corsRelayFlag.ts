import type { LoadtestConfig } from './schema';

/** `run --cors-relay`: turns on `browser.corsRelay` for this invocation. Without the flag the config's own value is untouched (so it stays off unless the config opts in). */
export const applyCorsRelayFlag = (config: LoadtestConfig, flagPresent: boolean): LoadtestConfig =>
  flagPresent ? { ...config, browser: { ...config.browser, corsRelay: true } } : config;
