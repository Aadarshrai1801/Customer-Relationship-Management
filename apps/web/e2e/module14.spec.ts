import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';

function tag(): string {
  return randomBytes(4).toString('hex');
}

const API = 'http://localhost:3001/v1';

async function signup(page: import('@playwright/test').Page, email: string, orgName: string) {
  await page.goto('/signup');
  await page.getByLabel('Workspace name').fill(orgName);
  await page.getByLabel('Your name').fill('Nexus Admin');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-12');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: /Good to see you/ })).toBeVisible();
}

test.describe('Module 14: scheduling, approvals, inbox, territories, SLA, cohorts', () => {
  test('booking links accept a public booking', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const linkName = `Intro ${id}`;
    await page.goto('/settings/scheduling');
    await expect(page.getByRole('heading', { name: 'Scheduling' })).toBeVisible();
    await page.getByRole('button', { name: '+ New Link' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(linkName);
    await dialog.getByLabel('Duration (minutes)').selectOption('30');
    await dialog.getByRole('button', { name: 'Create Link' }).click();
    await expect(page.getByText(linkName).first()).toBeVisible();

    const urlCode = page.locator('code', { hasText: '/book/' }).first();
    await expect(urlCode).toBeVisible();
    const publicPath = (await urlCode.textContent())?.trim();
    expect(publicPath).toMatch(/^\/book\//);

    await page.goto(publicPath!);
    await expect(page.getByRole('heading', { name: linkName })).toBeVisible();
    const slotSelect = page.getByLabel('Time slot');
    await expect
      .poll(async () => slotSelect.locator('option').count(), { timeout: 15000 })
      .toBeGreaterThan(1);
    await slotSelect.selectOption({ index: 1 });
    await page.getByLabel('Your name').fill('E2E Booker');
    await page.getByLabel('Work email').fill(`booker-${id}@example.test`);
    await page.getByRole('button', { name: 'Book meeting' }).click();
    await expect(page.getByText(/Booked/i).first()).toBeVisible();
  });

  test('approvals surface pending requests with self-approval blocked', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const product = await page.request.post(`${API}/products`, {
      data: { name: `Widget ${id}`, unitPrice: 10000, currency: 'USD' },
    });
    expect(product.ok()).toBe(true);
    const productId = ((await product.json()) as { product: { id: string } }).product.id;

    const deal = await page.request.post(`${API}/deals`, {
      data: { name: `Discount Deal ${id}`, amount: 10000 },
    });
    expect(deal.ok()).toBe(true);
    const dealId = ((await deal.json()) as { deal: { id: string } }).deal.id;

    const line = await page.request.post(`${API}/deals/${dealId}/line-items`, {
      data: { productId, quantity: 1 },
    });
    expect(line.ok()).toBe(true);

    const quote = await page.request.post(`${API}/quotes`, {
      data: { dealId, discountRate: 0.5 },
    });
    expect(quote.ok()).toBe(true);
    const quoteId = ((await quote.json()) as { quote: { id: string } }).quote.id;

    const requested = await page.request.post(`${API}/approvals`, {
      data: { entityType: 'quote', entityId: quoteId, action: 'quote_discount' },
    });
    expect(requested.ok()).toBe(true);

    await page.goto('/settings/approvals');
    await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
    await expect(page.getByText('quote_discount').first()).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).first().click();
    await expect(page.getByText(/own requests/i).first()).toBeVisible();
  });

  test('team inbox claims an inbound message', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const subject = `Help ${id}`;
    const synced = await page.request.post(`${API}/emails/sync`, {
      data: {
        provider: 'gmail',
        externalId: `msg-${id}-teaminbox`,
        from: `stranger-${id}@example.test`,
        to: [`admin-${id}@e2e.test`],
        subject,
      },
    });
    expect(synced.ok()).toBe(true);

    await page.goto('/emails');
    await expect(page.getByRole('heading', { name: 'Team inbox' })).toBeVisible();
    const row = page.getByLabel(`Inbox message ${subject}`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Claim' }).click();
    await expect(page.getByText('Message claimed').first()).toBeVisible();
  });

  test('territories, SLA policies, and cohorts render', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const territoryName = `West ${id}`;
    await page.goto('/settings/territories');
    await expect(page.getByRole('heading', { name: 'Territories', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '+ New Territory' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(territoryName);
    await dialog.getByLabel('Rule 1 value').fill('example.test');
    await dialog.getByRole('button', { name: 'Create Territory' }).click();
    await expect(page.getByText(territoryName).first()).toBeVisible();

    const policyName = `Touch ${id}`;
    await page.goto('/settings/sla');
    await expect(page.getByRole('heading', { name: 'SLAs' })).toBeVisible();
    await page.getByRole('button', { name: '+ New Policy' }).click();
    const slaDialog = page.getByRole('dialog');
    await slaDialog.getByLabel('Name').fill(policyName);
    await slaDialog.getByLabel('Hours').fill('72');
    await slaDialog.getByRole('button', { name: 'Create Policy' }).click();
    await expect(page.getByText(policyName).first()).toBeVisible();

    const contact = await page.request.post(`${API}/contacts`, {
      data: { name: `Cohort ${id}`, email: `cohort-${id}@example.test` },
    });
    expect(contact.ok()).toBe(true);

    await page.goto('/reports');
    await page.getByRole('button', { name: 'Cohorts', exact: true }).click();
    await expect(page.getByText(/contacts/i).first()).toBeVisible();
  });
});
