import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';

function tag(): string {
  return randomBytes(4).toString('hex');
}

async function signup(page: import('@playwright/test').Page, email: string, orgName: string) {
  await page.goto('/signup');
  await page.getByLabel('Workspace name').fill(orgName);
  await page.getByLabel('Your name').fill('Nexus Admin');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-12');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: /Good to see you/ })).toBeVisible();
}

test.describe('Module 10: Self-serve billing', () => {
  test('seat upgrade previews prorated charge and invoices on confirm', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/settings/billing');
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    await expect(page.getByText('USD 0.00').first()).toBeVisible();

    await page.getByLabel('Plan').selectOption('growth');
    const seats = page.getByLabel('Seats');
    await seats.clear();
    await seats.fill('2');

    await expect(page.getByText(/Charge of/).first()).toBeVisible();
    await expect(page.getByText('USD 60.00').first()).toBeVisible();

    await page.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText(/charged USD 60\.00/).first()).toBeVisible();
    await expect(page.getByText('USD 60.00').first()).toBeVisible();
  });
});
