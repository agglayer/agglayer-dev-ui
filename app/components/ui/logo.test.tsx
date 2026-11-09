import '@testing-library/jest-dom/vitest';
import { getLogoBadge } from '@/app/config';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Logo } from './logo';

vi.mock('@/app/config', () => ({ getLogoBadge: vi.fn() }));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />
}));

describe('Logo', () => {
  beforeEach(() => vi.mocked(getLogoBadge).mockReset());

  it('renders the badge text from config', () => {
    vi.mocked(getLogoBadge).mockReturnValue('MAINNET');
    const { container } = render(<Logo />);
    expect(container.querySelector('[data-test-id="logo-badge"]')).toHaveTextContent('MAINNET');
  });

  it('renders no badge when the configured text is empty', () => {
    vi.mocked(getLogoBadge).mockReturnValue('');
    const { container } = render(<Logo />);
    expect(container.querySelector('[data-test-id="logo-badge"]')).toBeNull();
  });
});
