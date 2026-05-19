import { z } from 'zod';

import { APP_MODES } from './appModes.mjs';

const modeEnum = z.enum(APP_MODES);
const nonEmptyString = z.string().trim().min(1);
const urlString = z.string().url();
const optionalUrlString = z.union([urlString, z.literal('')]);
const addressString = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

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
    proofApiSuffix: nonEmptyString,
    chainKeys: z.array(nonEmptyString),
    defaultFromChainKey: nonEmptyString.optional(),
    defaultToChainKey: nonEmptyString.optional()
  })
  .strict();

export const jsonConfigSchema = z
  .object({
    bridgeHubApiBaseUrl: urlString,
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
