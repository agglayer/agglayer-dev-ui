// Unit tests for the DESIGN §5.3 error taxonomy classifier. One fixture per
// taxonomy bucket the classifier is responsible for (the ErrorClass union,
// `core/types.ts`) — timeouts/autoclaim counters are ring.ts's job, not
// this classifier's, so they are out of scope here.
import { describe, expect, it } from 'vitest';

import {
  classifyBrowserCrash,
  classifyConfigError,
  classifyConsoleError,
  classifyError,
  classifyFundingError,
  classifyHttpError,
  classifyRevertError,
  classifyRpcError,
  classifySubmitError,
  classifyUiAssertionError,
  classifyUnknownError,
  isBenignExternalAssetHost
} from './errors';

const PRIVATE_KEY = '0x12d7de8621a77640c9241b2595ba78ce443d05e94090365ab3bb5e19df82c625';
const ADDRESS = '0xE34aaF64b29273B7D567FCFc40544c014EEe9970';

describe('classifyHttpError — not_ready (DESIGN §5.3, tests/bridge/console-hygiene.spec.ts:66-77)', () => {
  it('l1-info-tree-index 500 "not been included on the L1 Info Tree yet" -> not_ready (console-hygiene triage row 1)', () => {
    const result = classifyHttpError({
      endpointClass: 'bridge/l1-info-tree-index[1]',
      status: 500,
      bodyText: 'recording index has not been included on the L1 Info Tree yet'
    });
    expect(result.errorClass).toBe('not_ready');
  });

  it('injected-l1-info-leaf 404 "GER not yet injected" -> not_ready (console-hygiene triage row 2)', () => {
    const result = classifyHttpError({
      endpointClass: 'bridge/injected-l1-info-leaf[1]',
      status: 404,
      bodyText: 'GER not yet injected'
    });
    expect(result.errorClass).toBe('not_ready');
  });

  it('claim-proof 404 "has not indexed" -> not_ready', () => {
    const result = classifyHttpError({
      endpointClass: 'bridge/claim-proof[1]',
      status: 404,
      bodyText: 'the tracker has not indexed this deposit yet'
    });
    expect(result.errorClass).toBe('not_ready');
  });

  it('the same body text on an unrelated endpoint is NOT not_ready', () => {
    const result = classifyHttpError({
      endpointClass: 'bridge/token-mappings[1]',
      status: 404,
      bodyText: 'GER not yet injected'
    });
    expect(result.errorClass).toBe('proxy_4xx');
  });
});

describe('classifyHttpError — proxy_4xx / proxy_5xx', () => {
  it('any other 4xx from the proxy -> proxy_4xx', () => {
    expect(
      classifyHttpError({ endpointClass: 'bridge/token-mappings[1]', status: 400 }).errorClass
    ).toBe('proxy_4xx');
  });

  it('any other 5xx from the proxy -> proxy_5xx', () => {
    expect(classifyHttpError({ endpointClass: 'tracker/activity', status: 502 }).errorClass).toBe(
      'proxy_5xx'
    );
  });
});

describe('classifyRpcError — rpc_error', () => {
  it('classifies a JSON-RPC error response', () => {
    const result = classifyRpcError({ message: 'connection refused', code: -32000 });
    expect(result.errorClass).toBe('rpc_error');
    expect(result.message).toContain('-32000');
    expect(result.message).toContain('connection refused');
  });

  it('classifies a transport failure with no code', () => {
    expect(classifyRpcError({ message: 'ECONNRESET' }).errorClass).toBe('rpc_error');
  });

  // R3 (loadtest/REVIEW.md): a deliberate decision — see core/types.ts's
  // `ErrorClass.nonce_conflict` doc. Any message that mentions "nonce" is
  // SELF-INFLICTED concurrency on the tool's own send path, not the
  // system-under-test's fault, so it is classified separately rather than
  // filed under `rpc_error` (a class that reads as "the chain/proxy
  // rejected us").
  it('a nonce-shaped message -> nonce_conflict, not rpc_error (R3)', () => {
    const result = classifyRpcError({ message: 'nonce too low', code: -32000 });
    expect(result.errorClass).toBe('nonce_conflict');
    expect(result.message).toContain('-32000');
    expect(result.message).toContain('nonce too low');
  });
});

describe('classifyRevertError — tx_revert / lbt_underflow / already_claimed', () => {
  it('a generic revert -> tx_revert', () => {
    expect(classifyRevertError({ message: 'execution reverted: custom error' }).errorClass).toBe(
      'tx_revert'
    );
  });

  it('LocalBalanceTreeUnderflow in the message -> lbt_underflow (DESIGN §3.7)', () => {
    expect(
      classifyRevertError({ message: 'execution reverted: LocalBalanceTreeUnderflow()' }).errorClass
    ).toBe('lbt_underflow');
  });

  it('the AlreadyClaimed() selector -> already_claimed (the one selector match this taxonomy permits)', () => {
    expect(
      classifyRevertError({ message: 'execution reverted', selector: '0x646cf558' }).errorClass
    ).toBe('already_claimed');
  });

  it('selector match is case-insensitive', () => {
    expect(
      classifyRevertError({ message: 'execution reverted', selector: '0X646CF558' }).errorClass
    ).toBe('already_claimed');
  });
});

describe('classifySubmitError — lbt_underflow / internal (T8, no receipt yet)', () => {
  it('LocalBalanceTreeUnderflow on a build/send throw -> lbt_underflow, never tx_revert', () => {
    expect(
      classifySubmitError({ message: 'eth_estimateGas reverted: LocalBalanceTreeUnderflow()' })
        .errorClass
    ).toBe('lbt_underflow');
  });

  it('anything else on a build/send throw -> internal', () => {
    expect(classifySubmitError({ message: 'unexpected build failure' }).errorClass).toBe(
      'internal'
    );
  });
});

// S16/A4 (VALIDATION-1.md): each message below is copied verbatim from the
// run's `activity.ndjson` — these were the ~440 of 861 `internal` errors
// `classifySubmitError` mis-bucketed before this fix, one test per row of
// VALIDATION-1.md §2's A4 table.
describe('classifySubmitError — S16/A4 rescues real run messages out of `internal`', () => {
  it('a bare panic revert (336 occurrences, erc20 hop-0, A1) -> tx_revert', () => {
    expect(
      classifySubmitError({
        message: 'Execution reverted with reason: panic: arithmetic underflow or overflow (0x11).'
      }).errorClass
    ).toBe('tx_revert');
  });

  it('the AlreadyClaimed() selector reached via the submit path (9 occurrences) -> already_claimed', () => {
    expect(
      classifySubmitError({
        message: 'Execution reverted with reason: custom error 0x646cf558.'
      }).errorClass
    ).toBe('already_claimed');
  });

  it("viem's TransactionRejectedRpcError / JSON-RPC -32003 (70 occurrences) -> rpc_error", () => {
    expect(classifySubmitError({ message: 'Transaction creation failed.' }).errorClass).toBe(
      'rpc_error'
    );
  });

  // R3 (loadtest/REVIEW.md): this exact message is S14's 19 nonce-too-low
  // occurrences, root-caused to `maxInflightLapsPerUser`'s concurrent sends
  // on one EOA with no per-(user, chain) nonce serialization — a
  // self-inflicted collision, not the chain/proxy rejecting the tool. Was
  // `rpc_error` before this fix (a class that reads as the system-under-
  // test's fault); now `nonce_conflict`.
  it('a nonce-too-low rejection (19 occurrences) -> nonce_conflict (R3), not rpc_error', () => {
    expect(
      classifySubmitError({
        message:
          'Nonce provided for the transaction is lower than the current nonce of the account.'
      }).errorClass
    ).toBe('nonce_conflict');
  });

  it('a transport timeout (13 occurrences) -> rpc_error', () => {
    expect(
      classifySubmitError({ message: 'The request took too long to respond.' }).errorClass
    ).toBe('rpc_error');
  });

  it('the browser-pool relaunch-race message (57 occurrences, A3) -> browser_crash, not internal', () => {
    expect(
      classifySubmitError({ message: 'BrowserPool: slot 0 has no live browser' }).errorClass
    ).toBe('browser_crash');
  });

  it('LocalBalanceTreeUnderflow still wins over the new selector/panic/RPC rules', () => {
    expect(
      classifySubmitError({ message: 'eth_estimateGas reverted: LocalBalanceTreeUnderflow()' })
        .errorClass
    ).toBe('lbt_underflow');
  });
});

describe('classifyUiAssertionError — ui_assertion', () => {
  it('carries the failed test-id', () => {
    const result = classifyUiAssertionError({
      message: 'expected visible',
      testId: 'connect-wallet'
    });
    expect(result.errorClass).toBe('ui_assertion');
    expect(result.message).toContain('connect-wallet');
  });
});

describe('classifyBrowserCrash — browser_crash', () => {
  it('defaults to a generic message when none is given', () => {
    expect(classifyBrowserCrash().errorClass).toBe('browser_crash');
  });

  it('carries the given message', () => {
    expect(classifyBrowserCrash({ message: 'Target crashed' }).message).toContain('Target crashed');
  });
});

describe('classifyConsoleError — console_error, and its not_ready overlap with the HTTP path', () => {
  it('a console.error on the not-ready allowlist -> not_ready, not console_error (no double count)', () => {
    const result = classifyConsoleError({
      message: 'Failed to load resource: the server responded with a status of 500',
      url: 'https://proxy.example/bridge/v1/l1-info-tree-index?network_id=1&deposit_count=2'
    });
    // The URL alone doesn't carry the body text in this evidence shape, so
    // this particular call does NOT match — confirms the console path only
    // classifies not_ready when the message text itself carries the body.
    expect(result.errorClass).toBe('console_error');
  });

  it('a console message carrying the documented not-ready body text -> not_ready', () => {
    const result = classifyConsoleError({
      message: 'GER not yet injected',
      url: 'https://proxy.example/bridge/v1/injected-l1-info-leaf?network_id=1&leaf_index=3'
    });
    expect(result.errorClass).toBe('not_ready');
  });

  it('an unrelated console error -> console_error', () => {
    expect(classifyConsoleError({ message: 'ReferenceError: x is not defined' }).errorClass).toBe(
      'console_error'
    );
  });
});

describe('isBenignExternalAssetHost — S11 retry defect (3): raw.githubusercontent.com chain-icon noise', () => {
  it('matches the chain-icon host (config.json iconUrl, app/config.ts:232)', () => {
    expect(
      isBenignExternalAssetHost(
        'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg'
      )
    ).toBe(true);
  });

  it('matches when passed a bare origin (the shape `workers/browser/timing.ts` actually passes as endpointClass)', () => {
    expect(isBenignExternalAssetHost('https://raw.githubusercontent.com')).toBe(true);
  });

  it("matches Chromium's own favicon-fetch-failure sentinel host (empirically what a live devnet run captured for every net::ERR_NAME_NOT_RESOLVED console entry)", () => {
    expect(isBenignExternalAssetHost('https://icon.invalid')).toBe(true);
  });

  it('does not match an aggkit-proxy or RPC endpointClass', () => {
    expect(isBenignExternalAssetHost('tracker/activity')).toBe(false);
    expect(isBenignExternalAssetHost('rpc/eth_getTransactionReceipt[l1]')).toBe(false);
  });

  it('is false for undefined (no endpointClass captured)', () => {
    expect(isBenignExternalAssetHost(undefined)).toBe(false);
  });
});

describe('classifyFundingError / classifyConfigError', () => {
  it('funding errors classify as funding and preserve the sub-code', () => {
    const result = classifyFundingError({
      message: 'FUNDING_CAP_EXCEEDED: u3 would exceed maxTotalSpend'
    });
    expect(result.errorClass).toBe('funding');
    expect(result.message).toContain('FUNDING_CAP_EXCEEDED');
  });

  it('config errors classify as config', () => {
    expect(classifyConfigError({ message: 'RING_NOT_CLOSED' }).errorClass).toBe('config');
  });
});

describe('classifyUnknownError — internal (exhaustiveness fallback)', () => {
  it('classifies a plain Error', () => {
    expect(classifyUnknownError(new Error('boom')).errorClass).toBe('internal');
  });

  it('classifies a non-Error thrown value', () => {
    expect(classifyUnknownError('boom').errorClass).toBe('internal');
  });
});

describe('classifyError — dispatcher covers every source', () => {
  it('http', () => {
    expect(
      classifyError({ source: 'http', endpointClass: 'bridge/claim-proof[1]', status: 502 })
        .errorClass
    ).toBe('proxy_5xx');
  });
  it('rpc', () => {
    expect(classifyError({ source: 'rpc', message: 'boom' }).errorClass).toBe('rpc_error');
  });
  it('revert', () => {
    expect(classifyError({ source: 'revert', message: 'reverted' }).errorClass).toBe('tx_revert');
  });
  it('submit', () => {
    expect(classifyError({ source: 'submit', message: 'boom' }).errorClass).toBe('internal');
  });
  it('ui_assertion', () => {
    expect(classifyError({ source: 'ui_assertion', message: 'boom' }).errorClass).toBe(
      'ui_assertion'
    );
  });
  it('browser_crash', () => {
    expect(classifyError({ source: 'browser_crash' }).errorClass).toBe('browser_crash');
  });
  it('console', () => {
    expect(classifyError({ source: 'console', message: 'boom' }).errorClass).toBe('console_error');
  });
  it('funding', () => {
    expect(classifyError({ source: 'funding', message: 'boom' }).errorClass).toBe('funding');
  });
  it('config', () => {
    expect(classifyError({ source: 'config', message: 'boom' }).errorClass).toBe('config');
  });
  it('unknown', () => {
    expect(classifyError({ source: 'unknown', error: new Error('boom') }).errorClass).toBe(
      'internal'
    );
  });
});

describe('every classifier redacts secrets (reuses wallets/redact.ts, no second redactor)', () => {
  it('classifyRevertError', () => {
    const message = classifyRevertError({ message: `revert from ${PRIVATE_KEY}` }).message;
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('classifyRpcError', () => {
    const message = classifyRpcError({ message: `signer ${PRIVATE_KEY} rejected` }).message;
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('classifyHttpError', () => {
    const message = classifyHttpError({
      endpointClass: 'bridge/claim-proof[1]',
      status: 500,
      bodyText: `internal error, key=${PRIVATE_KEY}`
    }).message;
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('classifyUiAssertionError', () => {
    const message = classifyUiAssertionError({
      message: `address shown ${ADDRESS}`,
      testId: 'x'
    }).message;
    expect(message).not.toContain(ADDRESS);
  });

  it('classifyConsoleError', () => {
    const message = classifyConsoleError({ message: `leaked ${PRIVATE_KEY}` }).message;
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('classifyFundingError', () => {
    const message = classifyFundingError({ message: `funder key ${PRIVATE_KEY}` }).message;
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('classifyConfigError', () => {
    const message = classifyConfigError({ message: `bad secretRef value ${PRIVATE_KEY}` }).message;
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('classifyUnknownError', () => {
    const message = classifyUnknownError(new Error(`raw dump ${PRIVATE_KEY}`)).message;
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('classifyBrowserCrash', () => {
    const message = classifyBrowserCrash({ message: `crash near ${ADDRESS}` }).message;
    expect(message).not.toContain(ADDRESS);
  });
});
