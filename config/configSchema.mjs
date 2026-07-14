import { z } from 'zod';

import { APP_MODES } from './appModes.mjs';

const modeEnum = z.enum(APP_MODES);
const nonEmptyString = z.string().trim().min(1);
const urlString = z.string().url();
const optionalUrlString = z.union([urlString, z.literal('')]);
const addressString = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
// JSON object keys are always strings; network ids are validated as digit strings
// so they can be parsed to number when the aggregator config is built (app/config.ts).
const networkIdKey = z.string().regex(/^\d+$/);
// Exported so app/config.ts can validate the NEXT_PUBLIC_AGGKIT_BRIDGE_APIS
// env override against the same shape, rather than re-declaring it.
export const aggkitBridgeApisSchema = z.record(networkIdKey, urlString);

export const JsonNativeCurrencyConfigSchema = z
  .object({
    name: nonEmptyString,
    symbol: nonEmptyString,
    decimals: z.number().int().min(0)
  })
  .strict();

export const jsonChainConfigSchema = z
  .object({
    id: z.number().int().positive(),
    name: nonEmptyString,
    rpcUrl: urlString,
    explorerUrl: urlString,
    currency: JsonNativeCurrencyConfigSchema,
    iconUrl: urlString,
    networkId: z.number().int().min(0),
    isTestnet: z.boolean(),
    eta: z.number().int().min(0)
  })
  .strict();

export const jsonAppModeConfigSchema = z
  .object({
    label: nonEmptyString,
    bridgeAddress: addressString,
    // May be {} for modes that don't yet have an aggkit backend configured
    // (e.g. mainnet/testnet before their aggkit instances are stood up).
    aggkitBridgeApis: aggkitBridgeApisSchema,
    chainKeys: z.array(nonEmptyString),
    defaultFromChainKey: nonEmptyString.optional(),
    defaultToChainKey: nonEmptyString.optional()
  })
  .strict();

export const jsonConfigSchema = z
  .object({
    externalLinks: z
      .object({
        privacyPolicy: optionalUrlString,
        termsOfUse: optionalUrlString,
        contactSupport: optionalUrlString
      })
      .strict(),
    chains: z.record(nonEmptyString, jsonChainConfigSchema),
    appModes: z
      .object({
        default: modeEnum,
        configs: z.record(nonEmptyString, jsonAppModeConfigSchema)
      })
      .strict()
  })
  .strict();
