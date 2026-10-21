// Render-time redaction for report output (S53, heavy-load design §5).
//
// `results.json` still stores the validated config as it always did, and a run
// from before S53 may hold a keyed RPC URL both in `config.chains[].rpcUrl` and
// in `http` endpoint-class names. Everything a human-facing report prints
// (`summary.md` today, the HTML report in S54) must therefore go through the
// helpers here rather than echo those fields.
//
// Pure: no I/O, no clock. Imports only `wallets/redact.ts` for the shared
// token-shape rule.
import { isTokenLikeSegment } from '../wallets/redact';

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * `scheme://host[:port]`, with ` (path/query redacted)` appended when the
 * original had a path other than `/`, a query, a fragment or userinfo. An
 * unparseable value gives `<redacted url>`; an empty string stays empty (the
 * field is simply unset). RPC URLs must only ever be shown through this.
 */
export const safeUrlLabel = (url: string | undefined): string => {
  if (url === undefined || url === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '<redacted url>';
  }
  const hasMore =
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== '';
  return `${parsed.protocol}//${parsed.host}${hasMore ? ' (path/query redacted)' : ''}`;
};

/**
 * For a URL printed in `summary.md`, where today's output must stay unchanged
 * for every config that holds no secret (a proxy on `http://host/aggkitapi` is
 * printed in full). A URL is rewritten to `scheme://host/<redacted>` only when
 * it carries userinfo, a query, a fragment or a token-shaped path segment.
 */
export const redactUrlForDisplay = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '<redacted url>';
  }
  const secretShaped =
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname.split('/').some((segment) => isTokenLikeSegment(segment));
  return secretShaped ? `${parsed.protocol}//${parsed.host}/<redacted>` : url;
};

/**
 * What `results.json` stores for a chain's `rpcUrl` (S54): a URL that carries
 * userinfo, a query, a fragment or any path (`https://host/<api key>`,
 * `/v3/<key>`, `?apikey=...`) is cut down to `scheme://host[:port]/<redacted>`,
 * so a run never writes a keyed provider URL into `results.json`. A bare origin
 * (`http://203.0.113.10:8545`, a public node) is kept as is. Unparseable input
 * becomes `<redacted url>`.
 */
export const maskRpcUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '<redacted url>';
  }
  const hasMore =
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== '';
  return hasMore ? `${parsed.protocol}//${parsed.host}/<redacted>` : url;
};

// ---------------------------------------------------------------------------
// Secret references
// ---------------------------------------------------------------------------

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? '';

/**
 * `env:NAME` is shown (an env-var name is not a secret); `file:<basename>`
 * never shows the directory. Accepts a live `{env}` / `{file}` ref and the
 * `{ref: 'env:NAME'}` shape `results.json` already stores.
 */
export const refLabel = (ref: unknown): string => {
  if (typeof ref !== 'object' || ref === null) return '<unknown ref>';
  const record = ref as Record<string, unknown>;
  const fromString = (value: string): string => {
    if (value.startsWith('env:')) return value;
    if (value.startsWith('file:')) return `file:${basename(value.slice('file:'.length))}`;
    return '<unknown ref>';
  };
  if (typeof record.env === 'string') return `env:${record.env}`;
  if (typeof record.file === 'string') return `file:${basename(record.file)}`;
  if (typeof record.ref === 'string') return fromString(record.ref);
  return '<unknown ref>';
};

// ---------------------------------------------------------------------------
// Endpoint classes
// ---------------------------------------------------------------------------

export interface ChainRpcRef {
  key: string;
  rpcUrl: string;
}

const lastPathSegment = (url: string): string | null => {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
};

/**
 * Rewrites an `rpc/<segment>[/<method>]` endpoint class so that a token-shaped
 * segment (the API key of `https://host/<key>`) is never printed: it becomes
 * `rpc/<CHAIN_KEY>` when the segment is the last path segment of a configured
 * chain's `rpcUrl`, else `rpc/redacted`. A segment that is already a chain key,
 * a host/IP or a short path name (`l1rpc`) carries no secret and is kept as
 * is, so a keyless run renders exactly as it always did. Non-`rpc/` classes are
 * returned unchanged. This also repairs the class names of runs recorded before
 * S53 (the keyed ring-A run) at render time.
 */
const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

export const redactEndpointClass = (
  endpointClass: string,
  config: { chains: readonly ChainRpcRef[] }
): string => {
  const match = /^rpc\/([^/]+)(\/.*)?$/.exec(endpointClass);
  if (match === null) return endpointClass;
  const [, segment, rest = ''] = match;
  // Runs from before chain-key names label RPC classes by the provider host
  // (an IP or hostname): show the chain key that owns that host instead.
  const hostOwner = config.chains.find((chain) => hostnameOf(chain.rpcUrl) === segment);
  if (hostOwner !== undefined && !config.chains.some((chain) => chain.key === segment))
    return `rpc/${hostOwner.key}${rest}`;
  if (!isTokenLikeSegment(segment)) return endpointClass;
  if (config.chains.some((chain) => chain.key === segment)) return endpointClass;
  const owner = config.chains.find((chain) => lastPathSegment(chain.rpcUrl) === segment);
  return `rpc/${owner?.key ?? 'redacted'}${rest}`;
};

// ---------------------------------------------------------------------------
// Allowlisted config view
// ---------------------------------------------------------------------------

/**
 * How each leaf of the config schema is treated by `allowlistedConfigView`:
 * `show` copies the value, `url` / `secretRef` / `basename` print a safe label,
 * `hidden` drops it. Keyed by leaf path (`[]` = array element, `*` = record
 * entry). `redactReport.test.ts` walks the zod schema and fails when a leaf is
 * missing here, so a new config field cannot reach a report without a decision.
 */
export type ConfigKeyPolicy = 'show' | 'url' | 'secretRef' | 'basename' | 'hidden';

export const CONFIG_KEY_POLICY: Readonly<Record<string, ConfigKeyPolicy>> = {
  env: 'show',
  uiBaseUrl: 'url',
  aggkitProxyUrl: 'url',
  'chains[].key': 'show',
  'chains[].chainId': 'show',
  'chains[].networkId': 'show',
  'chains[].rpcUrl': 'url',
  'chains[].bridgeAddress': 'show',
  'chains[].explorerUrl': 'url',
  'chains[].nativeSymbol': 'show',
  'ring[]': 'show',
  'autoclaim.*.expected': 'show',
  'autoclaim.*.waitMs': 'show',
  'assets[].kind': 'show',
  'assets[].address': 'show',
  'assets[].originNetworkId': 'show',
  'assets[].amount': 'show',
  'assets[].decimals': 'show',
  'users.total': 'show',
  'users.browser': 'show',
  'users.wallets.mnemonicRef.env': 'secretRef',
  'users.wallets.mnemonicRef.file': 'secretRef',
  'users.wallets.startIndex': 'show',
  'users.wallets.privateKeysRef.env': 'secretRef',
  'users.wallets.privateKeysRef.file': 'secretRef',
  'users.funder.privateKeyRef.env': 'secretRef',
  'users.funder.privateKeyRef.file': 'secretRef',
  'users.funder.gasPerChain.*': 'show',
  'users.funder.assetTopUp': 'show',
  'users.funder.maxTotalSpend.*': 'show',
  'users.funder.maxTotalErc20Spend': 'show',
  'users.devnetFunding': 'show',
  'load.bridgesPerMinutePerUser': 'show',
  'load.durationMinutes': 'show',
  'load.rampUpSeconds': 'show',
  'load.maxInflightLapsPerUser': 'show',
  'browser.contextsPerBrowser': 'show',
  'browser.headless': 'show',
  'browser.trace': 'show',
  'browser.recycleContextAfterLaps': 'show',
  'browser.corsRelay': 'show',
  'timeouts.txReceiptMs': 'show',
  'timeouts.appearsInActivityMs': 'show',
  'timeouts.readyToClaimMs': 'show',
  'timeouts.claimedMs': 'show',
  'timeouts.hopMs': 'show',
  'timeouts.lapMs': 'show',
  'timeouts.pageLoadMs': 'show',
  'timeouts.walletConnectMs': 'show',
  'gas.bridgeGasOffset': 'show',
  'gas.claimGasOffset': 'show',
  'measurement.stageProbeIntervalMs': 'show',
  'measurement.walletBalanceIntervalMs': 'show',
  'measurement.l1InfoTree.pollIntervalMs': 'show',
  'measurement.l1InfoTree.gerManagerAddress': 'show',
  'measurement.httpWindowMs': 'show',
  'measurement.claimPreState': 'show',
  'pump.enabled': 'show',
  'pump.chainKey': 'show',
  'pump.destinationNetworkId': 'show',
  'pump.walletIndex': 'show',
  'pump.amount': 'show',
  'pump.intervalSeconds': 'show',
  'pump.maxTotalSpend': 'show',
  'pump.maxGasPriceGwei': 'show',
  'output.dir': 'basename',
  'output.activityLog': 'hidden'
};

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};

const pickDefined = (source: Json, keys: readonly string[]): Json =>
  Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
  );

const optionalLabel = (value: unknown, label: (v: string) => string): string | undefined =>
  typeof value === 'string' ? label(value) : undefined;

/**
 * The only view of the run configuration a human-facing report may embed.
 * Built from an allowlist (`CONFIG_KEY_POLICY`), never by copying the config
 * and deleting fields. Accepts the live config and the `redactConfigForReport`
 * shape stored in `results.json`. `options.pumpSender` is the derived pump
 * address from `results.pump.sender`, shown next to the pump parameters.
 */
export const allowlistedConfigView = (
  config: unknown,
  options: { pumpSender?: string } = {}
): Json => {
  const c = asRecord(config);
  const users = asRecord(c.users);
  const wallets = asRecord(users.wallets);
  const funder = users.funder === undefined ? undefined : asRecord(users.funder);
  const output = asRecord(c.output);
  const chains = Array.isArray(c.chains) ? c.chains.map(asRecord) : [];
  const assets = Array.isArray(c.assets) ? c.assets.map(asRecord) : [];
  const pump = c.pump === undefined ? undefined : asRecord(c.pump);
  const measurement = c.measurement === undefined ? undefined : asRecord(c.measurement);

  const walletRef = wallets.mnemonicRef ?? wallets.privateKeysRef;
  const view: Json = {
    env: c.env,
    ring: Array.isArray(c.ring) ? [...c.ring] : [],
    chains: chains.map((chain) => ({
      ...pickDefined(chain, ['key', 'chainId', 'networkId']),
      rpc: safeUrlLabel(optionalLabel(chain.rpcUrl, (v) => v)),
      ...pickDefined(chain, ['bridgeAddress', 'nativeSymbol']),
      explorer: safeUrlLabel(optionalLabel(chain.explorerUrl, (v) => v))
    })),
    aggkitProxy: safeUrlLabel(optionalLabel(c.aggkitProxyUrl, (v) => v)),
    ...(c.uiBaseUrl !== undefined
      ? { uiBase: safeUrlLabel(optionalLabel(c.uiBaseUrl, (v) => v)) }
      : {}),
    assets: assets.map((asset) =>
      pickDefined(asset, ['kind', 'address', 'originNetworkId', 'amount', 'decimals'])
    ),
    autoclaim: Object.fromEntries(
      Object.entries(asRecord(c.autoclaim)).map(([hop, entry]) => [
        hop,
        pickDefined(asRecord(entry), ['expected', 'waitMs'])
      ])
    ),
    users: {
      ...pickDefined(users, ['total', 'browser']),
      wallets: {
        kind: 'mnemonicRef' in wallets ? 'mnemonic' : 'privateKeys',
        ref: refLabel(walletRef),
        ...(wallets.startIndex !== undefined ? { startIndex: wallets.startIndex } : {})
      },
      ...(funder !== undefined
        ? {
            funder: {
              privateKeyRef: refLabel(funder.privateKeyRef),
              ...pickDefined(funder, [
                'gasPerChain',
                'maxTotalSpend',
                'assetTopUp',
                'maxTotalErc20Spend'
              ])
            }
          }
        : {}),
      ...pickDefined(users, ['devnetFunding'])
    },
    load: pickDefined(asRecord(c.load), [
      'bridgesPerMinutePerUser',
      'durationMinutes',
      'rampUpSeconds',
      'maxInflightLapsPerUser'
    ]),
    browser: pickDefined(asRecord(c.browser), [
      'contextsPerBrowser',
      'headless',
      'trace',
      'recycleContextAfterLaps',
      'corsRelay'
    ]),
    timeouts: pickDefined(asRecord(c.timeouts), [
      'txReceiptMs',
      'appearsInActivityMs',
      'readyToClaimMs',
      'claimedMs',
      'hopMs',
      'lapMs',
      'pageLoadMs',
      'walletConnectMs'
    ]),
    gas: pickDefined(asRecord(c.gas), ['bridgeGasOffset', 'claimGasOffset']),
    ...(measurement !== undefined
      ? {
          measurement: {
            ...pickDefined(measurement, [
              'stageProbeIntervalMs',
              'walletBalanceIntervalMs',
              'httpWindowMs',
              'claimPreState'
            ]),
            ...(measurement.l1InfoTree !== undefined
              ? {
                  l1InfoTree: pickDefined(asRecord(measurement.l1InfoTree), [
                    'pollIntervalMs',
                    'gerManagerAddress'
                  ])
                }
              : {})
          }
        }
      : {}),
    ...(pump !== undefined
      ? {
          pump: {
            ...pickDefined(pump, [
              'enabled',
              'chainKey',
              'destinationNetworkId',
              'walletIndex',
              'amount',
              'intervalSeconds',
              'maxTotalSpend',
              'maxGasPriceGwei'
            ]),
            ...(options.pumpSender !== undefined ? { sender: options.pumpSender } : {})
          }
        }
      : {}),
    output: { dir: typeof output.dir === 'string' ? basename(output.dir) : '' }
  };
  return view;
};
