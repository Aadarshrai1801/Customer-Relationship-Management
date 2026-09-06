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

test.describe('Module 2: Contacts, Accounts & Data Management', () => {
  test('custom fields admin creates text and formula fields', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/settings/custom-fields');
    await expect(page.getByRole('heading', { name: 'Custom Fields & Schema' })).toBeVisible();

    // Create a text custom field
    await page.getByRole('button', { name: '+ New Custom Field' }).click();
    await page.getByLabel('Field Label *').fill('Nickname');
    await page.getByLabel('System Key *').fill('nickname');
    await page.getByRole('button', { name: 'Save Field' }).click();
    await expect(page.getByText('Nickname').first()).toBeVisible();

    // Create a formula custom field
    await page.getByRole('button', { name: '+ New Custom Field' }).click();
    await page.getByLabel('Field Label *').fill('VIP Formula');
    await page.getByLabel('System Key *').fill('vip_formula');
    await page.getByLabel('Field Type *').selectOption('formula');
    await page.getByLabel('Formula Expression *').fill('CONCAT({nickname}, " (VIP)")');
    await page.getByRole('button', { name: 'Save Field' }).click();
    await expect(page.getByText('VIP Formula').first()).toBeVisible();
  });

  test('accounts list, create with hierarchy, and detail inline editing', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // Navigate to Accounts
    await page.goto('/accounts');
    await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible();

    // Create Parent Account
    await page.getByRole('button', { name: '+ New Account' }).click();
    await page.getByRole('dialog').getByLabel('Company Name *').fill('Wayne Enterprises');
    await page.getByRole('dialog').getByLabel('Industry').fill('Conglomerate');
    await page.getByRole('dialog').getByLabel('Website').fill('https://waynecorp.com');
    await page.getByRole('dialog').getByRole('button', { name: 'Create Account' }).click();
    await expect(page.getByText('Wayne Enterprises').first()).toBeVisible();

    // Create Child Subsidiary Account
    await page.getByRole('button', { name: '+ New Account' }).click();
    await page.getByRole('dialog').getByLabel('Company Name *').fill('Wayne Aerospace');
    await page.getByRole('dialog').getByLabel('Industry').fill('Aerospace');
    await page.getByRole('dialog').getByLabel('Parent Company (Hierarchy)').selectOption({ label: 'Wayne Enterprises' });
    await page.getByRole('dialog').getByRole('button', { name: 'Create Account' }).click();
    await expect(page.getByText('Wayne Aerospace').first()).toBeVisible();

    // Open detail of child account
    await page.getByRole('link', { name: 'Wayne Aerospace' }).click();
    await expect(page.getByRole('heading', { name: 'Wayne Aerospace' })).toBeVisible();
    await expect(page.getByText('Wayne Enterprises').first()).toBeVisible();

    // Inline edit website
    await page.getByTitle('Click to edit').first().click();
    const websiteInput = page.locator('input[type="text"]').last();
    await websiteInput.fill('https://aerospace.waynecorp.com');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Account updated')).toBeVisible();
  });

  test('contact creation with custom fields, duplicate warning, and timeline notes', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // First configure text and formula fields
    await page.goto('/settings/custom-fields');
    await page.getByRole('button', { name: '+ New Custom Field' }).click();
    await page.getByLabel('Field Label *').fill('Nickname');
    await page.getByLabel('System Key *').fill('nickname');
    await page.getByRole('button', { name: 'Save Field' }).click();
    await expect(page.getByText('Nickname').first()).toBeVisible();

    await page.getByRole('button', { name: '+ New Custom Field' }).click();
    await page.getByLabel('Field Label *').fill('VIP Formula');
    await page.getByLabel('System Key *').fill('vip_formula');
    await page.getByLabel('Field Type *').selectOption('formula');
    await page.getByLabel('Formula Expression *').fill('CONCAT({nickname}, " (VIP)")');
    await page.getByRole('button', { name: 'Save Field' }).click();
    await expect(page.getByText('VIP Formula').first()).toBeVisible();

    // Navigate to Contacts
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();

    // Create Contact 1
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill('Bruce Wayne');
    await page.getByLabel('Email Address *').fill('bruce@wayne.test');
    await page.getByLabel('Job Title').fill('Chairman');
    // Custom field input
    const nicknameInput = page.locator('#cf-nickname');
    if (await nicknameInput.isVisible()) {
      await nicknameInput.fill('Dark Knight');
    }
    await page.getByRole('button', { name: 'Create Contact' }).click();
    await expect(page.getByText('Bruce Wayne').first()).toBeVisible();

    // View Contact Detail
    await page.getByRole('link', { name: 'Bruce Wayne' }).click();
    await expect(page.getByRole('heading', { name: 'Bruce Wayne' })).toBeVisible();
    await expect(page.getByText('Chairman').first()).toBeVisible();

    // Check custom field and computed formula
    await expect(page.getByText('VIP Formula')).toBeVisible();
    await expect(page.getByText('Dark Knight (VIP)')).toBeVisible();

    // Add a note
    await page.getByPlaceholder('Write a note about this contact...').fill('Met for breakfast meeting.');
    await page.getByRole('button', { name: 'Post Note' }).click();
    await expect(page.getByText('Note added')).toBeVisible();
    await expect(page.getByText('Met for breakfast meeting.')).toBeVisible();

    // Check Timeline tab
    await page.getByRole('button', { name: 'Activity Timeline' }).click();
    await expect(page.getByText('Contact created', { exact: true }).first()).toBeVisible();

    // Go back to Contacts and create a duplicate contact with same email
    await page.goto('/contacts');
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill('Bruce W. Alternate');
    await page.getByLabel('Email Address *').fill('bruce@wayne.test'); // Duplicate email
    await page.getByRole('button', { name: 'Create Contact' }).click();

    // Duplicate Warning modal should appear without crashing or blocking
    await expect(page.getByRole('heading', { name: 'Duplicate Contact Detected' })).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).click();
  });

  test('deduplication review queue and per-field merge picker', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // Create two duplicate contacts
    await page.goto('/contacts');
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill('Clark Kent');
    await page.getByLabel('Email Address *').fill('clark@dailyplanet.test');
    await page.getByLabel('Job Title').fill('Reporter');
    await page.getByRole('button', { name: 'Create Contact' }).click();

    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill('Clark J. Kent');
    await page.getByLabel('Email Address *').fill('clark@dailyplanet.test');
    await page.getByLabel('Job Title').fill('Senior Investigative Reporter');
    await page.getByRole('button', { name: 'Create Contact' }).click();
    // Dismiss warning dialog
    await page.getByRole('button', { name: 'Dismiss' }).click();

    // Navigate to Duplicates queue
    await page.goto('/duplicates');
    await expect(page.getByRole('heading', { name: 'Deduplication Review Queue' })).toBeVisible();

    // Candidate should be listed
    await expect(page.getByText('Clark Kent')).toBeVisible();
    await expect(page.getByRole('button', { name: /Review & Merge/i })).toBeVisible();

    // Open merge picker
    await page.getByRole('button', { name: /Review & Merge/i }).click();
    await expect(page.getByRole('heading', { name: 'Merge Contacts' })).toBeVisible();

    // Per-field conflict selection
    const primaryButtons = page.getByRole('button', { name: 'Primary' });
    if ((await primaryButtons.count()) > 0) {
      await primaryButtons.first().click();
    }

    // Confirm merge
    await page.getByRole('button', { name: 'Confirm & Merge Records' }).click();
    await expect(page.getByText('Merged contact successfully')).toBeVisible();
  });

  test('command palette opens with button or shortcut and navigates', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // Open command palette via search button
    await page.getByRole('button', { name: /Search or command/i }).click();
    await expect(page.getByPlaceholder('Type a command or navigate...')).toBeVisible();

    // Filter for Contacts
    await page.getByPlaceholder('Type a command or navigate...').fill('Contacts');
    await page.getByRole('button', { name: /Contacts Browse & search contacts/i }).click();

    await expect(page).toHaveURL(/\/contacts/);
    await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
  });

  test('import wizard uploads csv, validates dry run, and commits', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/imports');
    await expect(page.getByRole('heading', { name: 'Import & Export Data' })).toBeVisible();

    // Upload a small valid CSV
    const csvContent = 'name,email,title,lifecycleStage\nDiana Prince,diana@themyscira.test,Ambassador,customer\nArthur Curry,arthur@atlantis.test,King,lead\n';
    await page.locator('input[type="file"]').setInputFiles({
      name: 'contacts.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csvContent),
    });

    // Should transition to Step 2: Map Fields
    await expect(page.getByText('Step 2: Map Columns to CRM Fields')).toBeVisible();
    await expect(page.getByText('Diana Prince')).toBeVisible();

    // Proceed to dry-run validation
    await page.getByRole('button', { name: /Validate & Preview/i }).click();
    await expect(page.getByText('Step 3: Dry-Run Validation Results')).toBeVisible();
    await expect(page.getByText('Valid & Ready to Import')).toBeVisible();

    // Commit the import
    await page.getByRole('button', { name: /Commit Import/i }).click();
    await expect(page.getByRole('heading', { name: 'Import Completed Successfully!' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'View Contacts' })).toBeVisible();
  });
});

