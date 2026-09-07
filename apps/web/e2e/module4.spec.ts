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

async function createDeal(page: import('@playwright/test').Page, name: string, amount: string) {
  await page.getByRole('button', { name: '+ New Deal' }).click();
  await page.getByLabel('Deal name').fill(name);
  await page.getByLabel('Amount (USD)').fill(amount);
  await page.getByRole('button', { name: 'Create Deal' }).click();
  await expect(page.getByText(`Deal "${name}" created`).first()).toBeVisible();
  await expect(page.getByRole('link', { name })).toBeVisible();
}

test.describe('Module 4: Deals, Pipelines & Sales Forecasting', () => {
  test('deal creation, board forecast, stage progression, and loss gate', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/deals');
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();

    const dealName = `Acme Expansion ${id}`;
    await createDeal(page, dealName, '12000');

    // Forecast header reflects the new open deal (Discovery = 10% probability)
    await expect(page.getByText('1 open deals')).toBeVisible();
    await expect(page.getByText(/weighted/)).toBeVisible();

    // Deal sits in the first-stage column
    const discoveryColumn = page.getByRole('listitem', { name: /Discovery/ });
    await expect(discoveryColumn.getByRole('link', { name: dealName })).toBeVisible();

    // Open the detail page
    await page.getByRole('link', { name: dealName }).click();
    await expect(page.getByRole('heading', { name: dealName })).toBeVisible();
    await expect(page.getByText('OPEN').first()).toBeVisible();

    // Inline-edit the deal name
    await page.getByTitle('Click to edit').first().click();
    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill(`${dealName} Plus`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Deal updated').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: `${dealName} Plus` })).toBeVisible();

    // Progress Discovery -> Proposal through the stepper
    await page.getByRole('button', { name: /Proposal/ }).click();
    await expect(page.getByText('Deal stage updated').first()).toBeVisible();
    const proposalStep = page.getByRole('button', { name: /Proposal/ });
    await expect(proposalStep).toHaveAttribute('aria-current', 'step');

    // Stage history records the move
    await expect(page.getByText(/Discovery → Proposal/)).toBeVisible();

    // Closed Lost requires a reason: confirm stays disabled until typed
    await page.getByRole('button', { name: /Closed Lost/ }).click();
    await expect(page.getByRole('dialog').getByText('Close as lost')).toBeVisible();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Move to lost' }),
    ).toBeDisabled();
    await page.getByLabel('Loss reason').fill('Chose a competitor');
    await page.getByRole('dialog').getByRole('button', { name: 'Move to lost' }).click();

    await expect(page.getByText('LOST').first()).toBeVisible();
    await expect(page.getByRole('note')).toContainText('Chose a competitor');
  });

  test('closed won confirms explicitly when no line items exist', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/deals');
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();

    const dealName = `Globex Renewal ${id}`;
    await createDeal(page, dealName, '8000');
    await page.getByRole('link', { name: dealName }).click();
    await expect(page.getByRole('heading', { name: dealName })).toBeVisible();

    // No products attached yet
    await expect(page.getByText('No products attached.')).toBeVisible();

    await page.getByRole('button', { name: /Closed Won/ }).click();
    await expect(page.getByRole('dialog').getByText('Close as won')).toBeVisible();
    await expect(
      page.getByRole('dialog').getByText(/no products or line items yet/i),
    ).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm won' }).click();

    await expect(page.getByText('WON').first()).toBeVisible();
  });

  test('deal custom fields are definable and render on the detail page', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // Define a Deal custom field
    await page.goto('/settings/custom-fields');
    await expect(page.getByRole('heading', { name: 'Custom Fields & Schema' })).toBeVisible();
    await page.getByRole('button', { name: 'Deal Custom Fields' }).click();
    await expect(page.getByText('Deal Field Definitions')).toBeVisible();

    await page.getByRole('button', { name: '+ New Custom Field' }).click();
    await page.getByLabel('Field Label *').fill('Deal Source');
    await page.getByLabel('System Key *').fill('deal_source');
    await page.getByRole('button', { name: 'Save Field' }).click();
    await expect(page.getByText('Deal Source').first()).toBeVisible();

    // Create a deal and verify the field renders on its detail page
    await page.goto('/deals');
    const dealName = `Initech Upsell ${id}`;
    await createDeal(page, dealName, '4500');
    await page.getByRole('link', { name: dealName }).click();
    await expect(page.getByRole('heading', { name: dealName })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Custom fields' })).toBeVisible();
    await expect(page.getByText('Deal Source', { exact: true }).first()).toBeVisible();
  });

  test('custom line items attach with totals and skip the won confirm', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/deals');
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();

    const dealName = `Hooli Services ${id}`;
    await createDeal(page, dealName, '6000');
    await page.getByRole('link', { name: dealName }).click();
    await expect(page.getByRole('heading', { name: dealName })).toBeVisible();

    // Add a custom (non-catalog) line item with qty/discount/tax
    await page.getByRole('button', { name: 'Custom line' }).click();
    await page.getByLabel('Line name').fill('Onboarding package');
    await page.getByLabel(/Unit price/).fill('1000');
    await page.getByLabel('Qty').fill('2');
    await page.getByLabel('Discount %').fill('10');
    await page.getByRole('button', { name: 'Add line item' }).click();

    await expect(page.getByText('Line item added').first()).toBeVisible();
    await expect(page.getByText('Onboarding package').first()).toBeVisible();
    // 2 x 1000 x (1 - 0.10) = 1800.00
    await expect(page.getByText('USD 1,800.00').first()).toBeVisible();

    // With line items present, Closed Won moves directly without the confirm dialog
    await page.getByRole('button', { name: /Closed Won/ }).click();
    await expect(page.getByText('Deal stage updated').first()).toBeVisible();
    await expect(page.getByText('WON').first()).toBeVisible();
  });

  test('delete deal requires confirmation and returns to the board', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/deals');
    const dealName = `Umbrella Trial ${id}`;
    await createDeal(page, dealName, '1500');
    await page.getByRole('link', { name: dealName }).click();
    await expect(page.getByRole('heading', { name: dealName })).toBeVisible();

    await page.getByRole('button', { name: 'Delete deal' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Delete deal' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete deal' }).click();

    await expect(page.getByText('Deal deleted').first()).toBeVisible();
    await expect(page).toHaveURL(/\/deals$/);
    await expect(page.getByRole('link', { name: dealName })).toHaveCount(0);
  });
});
