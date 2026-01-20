import type { Page } from '@playwright/test';

export const BridgePage = ({ page }: { page: Page }) => {
  const navigate = async () => {
    await page.goto('/');
  };

  return { navigate };
};
