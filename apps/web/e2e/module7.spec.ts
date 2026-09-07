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

async function createDeal(
  page: import('@playwright/test').Page,
  name: string,
  amount: string,
  category: 'Commit' | 'Best case' | 'Pipeline',
) {
  await page.goto('/deals');
  await page.getByRole('button', { name: '+ New Deal' }).click();
  await page.getByLabel('Deal name').fill(name);
  await page.getByLabel('Amount (USD)').fill(amount);
  await page.getByRole('button', { name: 'Create Deal' }).click();
  await expect(page.getByText(`Deal "${name}" created`).first()).toBeVisible();
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByLabel('Forecast category').selectOption({ label: category });
  await expect(page.getByText('Deal updated').first()).toBeVisible();
}

test.describe('Module 7: Reporting & Analytics', () => {
  test('forecast categories roll into commit, best case, and pipeline buckets', async ({
    page,
  }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await createDeal(page, `Commit Corp ${id}`, '10000', 'Commit');
    await createDeal(page, `Bestco ${id}`, '20000', 'Best case');

    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();

    // Buckets: commit 10k, best case 30k (commit + best), weighted 3k at 10%.
    await expect(page.getByText('USD 10,000.00').first()).toBeVisible();
    await expect(page.getByText('USD 30,000.00').first()).toBeVisible();
    await expect(page.getByText('USD 3,000.00').first()).toBeVisible();
    await expect(page.getByText('Nexus Admin').first()).toBeVisible();
    await expect(page.getByText('Live view')).toBeVisible();

    // Refresh bypasses the cache and keeps the numbers.
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('USD 10,000.00').first()).toBeVisible();
  });

  test('pipeline report shows stage distribution', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await createDeal(page, `Pipe Deal ${id}`, '5000', 'Pipeline');

    await page.goto('/reports');
    await page.getByRole('button', { name: 'Pipeline' }).click();
    await expect(page.getByText('Discovery').first()).toBeVisible();
    await expect(page.getByText(/1 · USD 5,000\.00/).first()).toBeVisible();
  });

  test('activity report reflects a logged call', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/tasks');
    const subject = `Report call ${id}`;
    await page.getByLabel('Subject').fill(subject);
    await page.getByRole('button', { name: 'Log activity' }).click();
    await expect(page.getByText('Activity logged').first()).toBeVisible();

    await page.goto('/reports');
    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByText(/1 total/).first()).toBeVisible();
    await expect(page.getByText('call', { exact: true }).first()).toBeVisible();
  });

  test('conversion tab shows open deals and dashboards render widgets', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await createDeal(page, `Funnel Deal ${id}`, '7000', 'Pipeline');

    await page.goto('/reports');
    await page.getByRole('button', { name: 'Conversion' }).click();
    await expect(page.getByText(/Open 1/).first()).toBeVisible();
    await expect(page.getByText(/Win rate 0%/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Dashboards' }).click();
    await expect(page.getByText('No dashboards yet')).toBeVisible();

    const boardName = `Sales overview ${id}`;
    await page.getByRole('button', { name: '+ New Dashboard' }).click();
    await page.getByLabel('Name').fill(boardName);
    await page.getByRole('button', { name: 'Create Dashboard' }).click();
    await expect(page.getByText(`Dashboard "${boardName}" created`).first()).toBeVisible();

    const widget = page.getByRole('region', { name: 'Widget Forecast' });
    await expect(widget).toBeVisible();
    await expect(widget.getByText('USD 7,000.00').first()).toBeVisible();
  });
});
