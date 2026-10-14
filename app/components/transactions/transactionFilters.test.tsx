import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TransactionFilters } from './transactionFilters';

// S10 regression: selecting "All transactions" mapped the status Dropdown's
// `null` sentinel to the string 'all' for display, but `onSelect` never
// mapped it back -- so `onFilterChange` received `status: 'all'`, which
// `services/transactions.ts` then compared against every real
// `TransactionStatus` value (never matching), rendering an empty list even
// though transactions existed. Clicking "Ready to claim" first (a non-null
// status) then "All transactions" reproduces the exact manual-repro path.
describe('TransactionFilters', () => {
  it('selecting "All transactions" clears the status filter instead of sending the literal "all"', () => {
    const onFilterChange = vi.fn();

    render(<TransactionFilters onFilterChange={onFilterChange} />);

    fireEvent.click(screen.getByText('Status'));
    fireEvent.click(screen.getByText('Ready to claim'));
    expect(onFilterChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'READY_TO_CLAIM' })
    );

    fireEvent.click(screen.getByText('Ready to claim'));
    fireEvent.click(screen.getByText('All transactions'));

    expect(onFilterChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }));
  });
});
