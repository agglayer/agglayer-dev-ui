import {
  BaseError,
  InternalRpcError,
  TransactionExecutionError,
  UserRejectedRequestError
} from 'viem';
import { describe, expect, it } from 'vitest';

import { isUserRejectionError, isUserRejectionMessage } from './walletErrors';

describe('isUserRejectionMessage', () => {
  it('is false for no message', () => {
    expect(isUserRejectionMessage(undefined)).toBe(false);
    expect(isUserRejectionMessage('')).toBe(false);
  });

  it.each([
    'User rejected the request.',
    'MetaMask Tx Signature: User denied transaction signature.',
    'The user refused to sign'
  ])('matches the wallet rejection copy %#', (message) => {
    expect(isUserRejectionMessage(message)).toBe(true);
  });

  it('does not match an on-chain revert', () => {
    // The AlreadyClaimed race path -- "reverted" must NOT read as
    // "rejected", or useClaimExecution would skip the isClaimed backoff
    // that exists precisely for it.
    expect(isUserRejectionMessage('Execution reverted for an unknown reason')).toBe(false);
  });
});

describe('isUserRejectionError', () => {
  it('detects viem rejections nested in the error viem actually throws', () => {
    // sendTransaction surfaces a TransactionExecutionError with the
    // rejection as its `cause`, so `instanceof UserRejectedRequestError` on
    // the caught value is false -- hence BaseError.walk rather than a bare
    // instanceof. (The substring fallback would also catch THIS one, since
    // viem stamps its own fixed "User rejected the request." shortMessage
    // into the wrapper's message. The genuinely substring-invisible case is
    // the unmapped raw code 4001 below.)
    const rejection = new UserRejectedRequestError(new Error('provider said no'));
    const thrown = new TransactionExecutionError(rejection, { account: null });

    expect(thrown instanceof UserRejectedRequestError).toBe(false);
    expect(thrown instanceof BaseError).toBe(true);
    expect(isUserRejectionError(thrown)).toBe(true);
  });

  it('detects a raw EIP-1193 code 4001 whose message no substring list can match', () => {
    // A wallet reporting the rejection in another locale: code 4001 is the
    // only signal, and it is the one the reviewer asked for.
    expect(isUserRejectionError({ code: 4001, message: 'Usuario canceló la solicitud' })).toBe(
      true
    );
  });

  it('detects a code 4001 nested down the cause chain', () => {
    const thrown = new Error('Failed to send transaction', {
      cause: { code: 4001, message: 'ユーザーが要求を拒否しました' }
    });
    expect(isUserRejectionError(thrown)).toBe(true);
  });

  it('falls back to the message when nothing is typed', () => {
    expect(isUserRejectionError(new Error('User denied transaction signature'))).toBe(true);
    expect(isUserRejectionError('User rejected the request')).toBe(true);
  });

  it('is false for an unrelated viem error', () => {
    const thrown = new TransactionExecutionError(new InternalRpcError(new Error('boom')), {
      account: null
    });
    expect(isUserRejectionError(thrown)).toBe(false);
  });

  it('is false for an on-chain revert and for non-error values', () => {
    expect(isUserRejectionError(new Error('Execution reverted for an unknown reason'))).toBe(false);
    expect(isUserRejectionError(undefined)).toBe(false);
    expect(isUserRejectionError(null)).toBe(false);
    expect(isUserRejectionError({})).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const cyclic: { message: string; cause?: unknown } = { message: 'boom' };
    cyclic.cause = cyclic;
    expect(isUserRejectionError(cyclic)).toBe(false);
  });
});
