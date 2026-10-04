// S07: `lbt_underflow` is matched by selector as well as by decoded name, so a
// revert surfacing as raw data (no `LocalBalanceTreeUnderflow` text) is still
// classified correctly (S03 §2.7 / S06: selector 0x14603c01).
import { describe, expect, it } from 'vitest';

import { classifyRevertError, classifySubmitError } from './errors';

const LBT_SELECTOR = '0x14603c01';
// ABI-encoded args (uint32,address,uint256,uint256) follow the 4-byte selector.
const RAW_DATA = `${LBT_SELECTOR}${'0'.repeat(64 * 4)}`;

describe('lbt_underflow selector match', () => {
  it('selector anywhere in a revert message -> lbt_underflow', () => {
    expect(
      classifyRevertError({ message: `execution reverted, data: "${RAW_DATA}"` }).errorClass
    ).toBe('lbt_underflow');
  });

  it('selector anywhere in a submit-time message -> lbt_underflow (not tx_revert/internal)', () => {
    expect(
      classifySubmitError({ message: `eth_estimateGas failed: Details: ${RAW_DATA}` }).errorClass
    ).toBe('lbt_underflow');
  });

  it('matches the selector case-insensitively', () => {
    expect(
      classifyRevertError({ message: `reverted with 0x14603C01${'0'.repeat(8)}` }).errorClass
    ).toBe('lbt_underflow');
  });

  it('an unrelated selector stays tx_revert', () => {
    expect(
      classifyRevertError({ message: `execution reverted, data: "0xdeadbeef${'0'.repeat(64)}"` })
        .errorClass
    ).toBe('tx_revert');
  });

  it('the decoded name still matches', () => {
    expect(
      classifyRevertError({ message: 'execution reverted: LocalBalanceTreeUnderflow()' }).errorClass
    ).toBe('lbt_underflow');
  });
});
