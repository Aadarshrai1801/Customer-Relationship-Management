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

test.describe('Module 3: Inbound Lead Management, Routing & Qualification', () => {
  test('lead custom fields, manual creation, and lifecycle stepper progression', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // 1. Configure a Lead custom field
    await page.goto('/settings/custom-fields');
    await expect(page.getByRole('heading', { name: 'Custom Fields & Schema' })).toBeVisible();

    // Click "Lead Custom Fields" tab
    await page.getByRole('button', { name: 'Lead Custom Fields' }).click();
    await expect(page.getByText('Lead Field Definitions')).toBeVisible();

    await page.getByRole('button', { name: '+ New Custom Field' }).click();
    await page.getByLabel('Field Label *').fill('Estimated Budget');
    await page.getByLabel('System Key *').fill('est_budget');
    await page.getByRole('button', { name: 'Save Field' }).click();
    await expect(page.getByText('Estimated Budget').first()).toBeVisible();

    // 2. Navigate to Leads list
    await page.goto('/leads');
    await expect(page.getByRole('heading', { name: 'Leads' })).toBeVisible();

    // 3. Create a new lead
    await page.getByRole('button', { name: '+ New Lead' }).click();
    await page.getByLabel('Full / Display Name').fill('Arthur Dent');
    await page.getByLabel('Email Address *').fill(`arthur-${id}@galaxy.test`);
    await page.getByLabel('Company').fill('Megadodo Publications');
    await page.getByLabel('Title / Job Role').fill('Lead Researcher');
    await page.getByLabel('Notes').fill('Inbound inquiry from conference booth.');

    // Save lead
    await page.getByRole('button', { name: 'Create Lead' }).click();

    // Should redirect to lead detail page
    await expect(page.getByRole('heading', { name: 'Arthur Dent' })).toBeVisible();
    await expect(page.getByText('Megadodo Publications').first()).toBeVisible();
    await expect(page.getByText('Stage 1')).toBeVisible();

    // 4. Progress status from New -> Contacted -> Qualified
    const contactedStep = page.getByRole('button', { name: /Stage 2/i });
    await contactedStep.click();
    await expect(page.getByText('CONTACTED').first()).toBeVisible();

    const qualifiedStep = page.getByRole('button', { name: /Stage 3/i });
    await qualifiedStep.click();
    await expect(page.getByText('QUALIFIED').first()).toBeVisible();

    // 5. Test Inline Edit
    await page.getByTitle('Click to edit').first().click();
    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill('Arthur P. Dent');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Lead updated').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Arthur P. Dent' })).toBeVisible();
  });

  test('5-minute deduplication window returns existing lead and prevents duplication', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/leads');
    await expect(page.getByRole('heading', { name: 'Leads' })).toBeVisible();

    const dupEmail = `prospect-${id}@acme.test`;

    // 1. First lead creation
    await page.getByRole('button', { name: '+ New Lead' }).click();
    await page.getByLabel('Full / Display Name').fill('Ford Prefect');
    await page.getByLabel('Email Address *').fill(dupEmail);
    await page.getByLabel('Company').fill('Sub-Etha Corp');
    await page.getByRole('button', { name: 'Create Lead' }).click();
    await expect(page.getByRole('heading', { name: 'Ford Prefect' })).toBeVisible();

    // 2. Immediately try creating the second lead with the same email within 5 minutes
    await page.goto('/leads');
    await page.getByRole('button', { name: '+ New Lead' }).click();
    await page.getByLabel('Full / Display Name').fill('Ford Prefect Alternate');
    await page.getByLabel('Email Address *').fill(dupEmail);
    await page.getByRole('button', { name: 'Create Lead' }).click();

    // Notification indicates deduplication
    await expect(page.getByText(/Lead already submitted within 5 minutes/i)).toBeVisible();

    // Go back to leads list and verify only 1 lead exists
    await page.goto('/leads');
    const tableRows = page.locator('tbody tr');
    await expect(tableRows).toHaveCount(1);
  });

  test('lead routing rules, rotation member ordering, and rep PTO availability', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/settings/lead-routing');
    await expect(page.getByRole('heading', { name: 'Lead Routing & Rep Availability' })).toBeVisible();

    // 1. Toggle availability to Out of Office
    const availCheckbox = page.locator('#isAvailableToggle');
    await availCheckbox.uncheck();
    await expect(page.getByText('🔴 Out of Office / Unavailable')).toBeVisible();

    await page.locator('#oooReason').fill('Attending Annual Summit');
    await page.getByRole('button', { name: 'Save Availability' }).click();
    await expect(page.getByText('Your availability status has been updated')).toBeVisible();

    // 2. Toggle back to Available
    await availCheckbox.check();
    await page.getByRole('button', { name: 'Save Availability' }).click();
    await expect(page.getByText('Your availability status has been updated')).toBeVisible();

    // 3. Create a Round-Robin Routing Rule
    await page.getByRole('button', { name: '+ Add Rule' }).click();
    await page.getByLabel('Rule Name *').fill('Inbound Website Rotation');
    await page.getByRole('button', { name: 'Save Rule' }).click();
    await expect(page.getByText('Inbound Website Rotation')).toBeVisible();
    await expect(page.getByText('ACTIVE').first()).toBeVisible();
  });

  test('web-to-lead embed snippet generator and live test console submission', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // Set up a routing rule so the ingested lead is assigned to the current user
    await page.goto('/settings/lead-routing');
    await page.getByRole('button', { name: '+ Add Rule' }).click();
    await page.getByLabel('Rule Name *').fill('Web Rotation');
    const repOption = page.getByRole('dialog').locator('span').filter({ hasText: /^Nexus Admin$/ });
    await expect(repOption).toBeVisible();
    await repOption.click();
    await expect(page.getByRole('dialog').getByText('#1')).toBeVisible();
    await page.getByRole('button', { name: 'Save Rule' }).click();
    await expect(page.getByText('Web Rotation')).toBeVisible();

    await page.goto('/settings/web-to-lead');
    await expect(page.getByRole('heading', { name: 'Web-to-Lead Ingestion' })).toBeVisible();

    // 1. Verify embed snippet contains honeypot and endpoint
    await expect(page.locator('pre')).toContainText('nexus-lead-form');
    await expect(page.locator('pre')).toContainText('name="_hp"');

    // 2. Submit a lead through the live testing console
    await page.locator('#testName').fill('Tricia McMillan');
    await page.locator('#testEmail').fill(`trillian-${id}@earth.test`);
    await page.locator('#testCompany').fill('Sub-Etha Radio');
    await page.getByRole('button', { name: 'Submit Test Lead' }).click();

    // 3. Verify success message and link to lead
    await expect(page.getByText(/Success! Lead ingested/i)).toBeVisible();
    await page.getByRole('link', { name: /View Lead/i }).click();

    await expect(page.getByRole('heading', { name: 'Tricia McMillan' })).toBeVisible();
    await expect(page.getByText('Sub-Etha Radio').first()).toBeVisible();

    // 4. Verify in-app notifications popover
    const bellBtn = page.getByRole('button', { name: /Notifications/i });
    await bellBtn.click();
    await expect(page.getByRole('dialog', { name: 'Notifications popover' })).toBeVisible();
    await expect(page.getByText(/New Lead Assigned: Tricia McMillan/i)).toBeVisible();
  });

  test('convert qualified lead into Contact and Account with note preservation', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // 1. Create a qualified lead
    await page.goto('/leads');
    await page.getByRole('button', { name: '+ New Lead' }).click();
    await page.getByLabel('Full / Display Name').fill('Slartibartfast');
    await page.getByLabel('Email Address *').fill(`fjords-${id}@magrathea.test`);
    await page.getByLabel('Company').fill('Magrathea Planetary Design');
    await page.getByLabel('Title / Job Role').fill('Chief Coastline Designer');
    await page.getByLabel('Notes').fill('Won award for Norwegian fjords design.');
    await page.getByRole('button', { name: 'Create Lead' }).click();

    await expect(page.getByRole('heading', { name: 'Slartibartfast' })).toBeVisible();

    // 2. Click Convert Lead
    await page.getByRole('button', { name: /Convert Lead/i }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Convert Lead' })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Magrathea Planetary Design')).toBeVisible();

    // 3. Confirm conversion
    await page.getByRole('dialog').getByRole('button', { name: 'Convert Lead' }).click();

    // 4. Should redirect to newly created Contact
    await expect(page.getByRole('heading', { name: 'Slartibartfast' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('fjords-' + id + '@magrathea.test').first()).toBeVisible();
    await expect(page.getByText('Chief Coastline Designer').first()).toBeVisible();

    // Verify converted contact preserved lead notes
    await expect(page.getByText('Won award for Norwegian fjords design.')).toBeVisible();

    // 5. Navigate back to Leads list and verify status is CONVERTED
    await page.goto('/leads');
    await expect(page.getByText('CONVERTED').first()).toBeVisible();
  });
});
