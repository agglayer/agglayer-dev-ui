import { expect, test } from '@playwright/test';
import { BridgePage } from './models/bridge-page';

test('load the homepage', async ({ page }) => {
  const bridgePage = BridgePage({ page });

  await bridgePage.navigate();

  await expect(page.getByTestId('bridge-card')).toBeVisible();
});
