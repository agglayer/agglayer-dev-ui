import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AmountInput } from './amountInput';

describe('AmountInput balance', () => {
  it('shows the balance text', () => {
    const { container } = render(<AmountInput value="" onChange={() => {}} balanceText="1.5" />);
    expect(container).toHaveTextContent('Balance: 1.5');
    expect(container.querySelector('[data-test-id="balance-error"]')).toBeNull();
  });

  it('shows an error with the detail in a tooltip instead of a 0 balance when the read failed', () => {
    const { container, getByRole } = render(
      <AmountInput value="" onChange={() => {}} balanceText="0" balanceError="HTTP error 403" />
    );
    const err = container.querySelector('[data-test-id="balance-error"]');
    expect(err).toHaveTextContent('Error');
    expect(err).not.toHaveTextContent('Balance: 0');
    expect(getByRole('tooltip', { hidden: true })).toHaveTextContent(
      "Couldn't load balance: HTTP error 403"
    );
  });
});
