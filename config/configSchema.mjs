import { z } from 'zod';

import { APP_MODES } from './appModes.mjs';

const modeEnum = z.enum(APP_MODES);
const nonEmptyString = z.string().trim().min(1);
// Every absolute URL in config.json must be http(s). zod's `.url()` only
// requires that the value parse as a URL, so on its own it accepts
// `javascript:...`, `data:...`, `file:...` and any other scheme. config.json is
// mounted at container start (see entrypoint.sh / docs/docker.md), so it is an
// untrusted input wherever someone other than the app owner can supply it, and
// several of these values reach navigation sinks unmodified — `externalLinks.*`
// and `explorerUrl` land in `<a href>` (app/components/header/constants.ts,
// bridgeSuccessView.tsx, claimResultModal.tsx) and in
// `window.open(...)` (app/components/transactions/transactionListItem.tsx:126,
// transactionDetailsModal.tsx:107,139, bridge/tokenSelectorManageView.tsx:168).
// A `javascript:` value there executes with the app's origin. Constrain the
// scheme here, at the single choke point every loader shares
// (config/configLoader.mjs's normalizeConfigOrThrow), rather than at each sink.
const isHttpUrl = (value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};
const urlString = z
  .string()
  .url()
  .refine(isHttpUrl, { message: 'must use the http or https scheme' });
const optionalUrlString = z.union([urlString, z.literal('')]);
const addressString = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
// An origin-relative path: exactly one leading slash. `//host` (protocol-relative)
// is deliberately rejected — it changes origin and would reintroduce the
// cross-origin/SSRF surface that relative URLs exist to remove.
const relativeUrlPath = z.string().regex(/^\/(?!\/)[^\s]*$/);
const aggkitBaseUrlString = z.union([urlString, relativeUrlPath]);
// A single URL fronting every network for a mode -- one multiplexing
// aggkit-proxy instance (PROXY + TRACKER components, see docs/deployment.md)
// distinguishing networks by the `?network_id=` query param rather than by
// host. Exported so app/config.ts can validate the NEXT_PUBLIC_AGGKIT_PROXY
// env override against the same shape, rather than re-declaring it.
//
// This used to be one of two mutually-exclusive fields on a mode config, the
// other being a per-network `aggkitBridgeApis` map (networkId -> aggkit REST
// base URL) for a mode whose networks were served by distinct per-network
// aggkit backends instead of one shared proxy. That map form has been
// removed from this schema: every mode this app ships now goes through one
// aggkit-proxy, so the per-network map no longer models anything this repo's
// own config.json needs. kurtosis-cdk's dev-ui config template
// (static_files/additional_services/bridge-ui/aggkit-dev-ui-config.json.tmpl)
// still generates the old map-form field as of this writing -- that template
// needs a follow-up migration (tracked separately, kurtosis-cdk-side) to emit
// `aggkitProxy` instead; until it lands, a config produced by that template
// would fail this schema's `.strict()` check (an unrecognized `aggkitBridgeApis`
// key). This is a deliberate, temporary, tracked cross-repo skew, not an
// oversight.
export const aggkitProxySchema = aggkitBaseUrlString;

export const JsonNativeCurrencyConfigSchema = z
  .object({
    name: nonEmptyString,
    symbol: nonEmptyString,
    decimals: z.number().int().min(0),
    // Optional override of the address this chain's native gas token is
    // identified/displayed by. Omit to keep the default: app/utils/config.ts's
    // createChainEntry falls back to ZERO_ADDRESS, the AggLayer bridge
    // contract's convention for "native asset" regardless of this value --
    // the actual on-chain bridge call always hardcodes ZERO_ADDRESS for a
    // native-asset deposit (app/hooks/useBridgeExecution.ts), so this only
    // affects the token's identity key and display, never what gets bridged.
    address: addressString.optional(),
    // Optional address of this chain's AggLayer bridge contract's own
    // `WETHToken` -- present only on a network whose native/gas token isn't
    // ether but a custom gasToken, where the bridge contract deploys a
    // wrapped-ETH contract at this address to represent mainnet ETH bridged
    // in (see AgglayerBridge.sol, agglayer/agglayer-contracts v12.2.3).
    // Omit or leave at the zero address (the default) to change nothing.
    // When set, gates two things in the app: the displayed balance for this
    // chain's native gas token is read from this ERC-20 instead of the
    // wallet's native balance (app/hooks/useTokenBalance.ts), AND bridging
    // that token out passes this as the `token` param to `bridgeAsset`
    // instead of the zero address (app/hooks/useBridgeExecution.ts) -- the
    // contract special-cases `token === WETHToken` into a privileged burn
    // requiring `msg.value === 0`, unlike the `token === address(0)` branch
    // which requires `msg.value === amount`.
    wethToken: addressString.optional()
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
    eta: z.number().int().min(0),
    // Per-chain override of the enclosing mode's `bridgeAddress` -- set this
    // only when this specific chain's deployed bridge contract differs from
    // every other chain in the mode (most modes share one deterministic
    // address across all their chains, hence the mode-level default). Omit to
    // inherit the mode's `bridgeAddress`; see app/config.ts's buildModeConfig.
    bridgeAddress: addressString.optional()
  })
  .strict();

export const jsonAppModeConfigSchema = z
  .object({
    label: nonEmptyString,
    bridgeAddress: addressString,
    // A single aggkit-proxy fronting every network in this mode, tracker
    // included. May be omitted for a mode with no aggkit backend configured
    // yet -- the documented "not yet configured" escape hatch (a disabled
    // mode with fewer than two chainKeys, or one whose real proxy URL doesn't
    // exist yet).
    aggkitProxy: aggkitProxySchema.optional(),
    chainKeys: z.array(nonEmptyString),
    defaultFromChainKey: nonEmptyString.optional(),
    defaultToChainKey: nonEmptyString.optional()
  })
  .strict();

const routeAutoclaimSchema = z
  .object({
    // Whether an autoclaim service is expected to claim this route on the user's
    // behalf. When false, the manual "Claim tokens" button shows as soon as the
    // deposit is READY_TO_CLAIM (legacy behavior).
    expectedAutoclaim: z.boolean(),
    // Grace period (milliseconds, measured from when the deposit first becomes
    // READY_TO_CLAIM) to wait for the autoclaim service before surfacing the
    // manual claim button. Only used when expectedAutoclaim is true.
    waitForAutoclaimMs: z.number().int().min(0).optional()
  })
  .strict();

// Per-route autoclaim UX config. Optional in config.json — app/config.ts applies
// per-route defaults for any route omitted here.
export const autoclaimConfigSchema = z
  .object({
    l1_to_l2: routeAutoclaimSchema.optional(),
    l2_to_l1: routeAutoclaimSchema.optional(),
    l2_to_l2: routeAutoclaimSchema.optional()
  })
  .strict();

// WalletConnect/Reown Cloud project id, read at RUNTIME from the served
// config.json -- this is what makes it settable in a prebuilt container
// image without a rebuild (a1-runtime-config-design.md §6.3; see
// app/config.ts's resolveProjectIdOverride and entrypoint.sh's structural
// check). Required (not `.optional()`) so a config.json missing this field
// fails validation loudly rather than silently falling back to `undefined` --
// see README/docs/config.md for the placeholder value that reproduces the
// pre-existing graceful-degradation ("basic" AppKit mode) behavior.
export const walletConnectConfigSchema = z
  .object({
    projectId: nonEmptyString
  })
  .strict();

export const jsonConfigSchema = z
  .object({
    autoclaim: autoclaimConfigSchema.optional(),
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
      .strict(),
    walletConnect: walletConnectConfigSchema
  })
  .strict();
