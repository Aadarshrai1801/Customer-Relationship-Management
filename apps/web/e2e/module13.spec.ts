import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

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

test.describe('Module 13: P1 backlog batch', () => {
  test('notification preferences persist per channel', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/settings/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

    const emailBox = await page.getByLabel('Mentions Email');
    await expect(emailBox).toBeChecked();
    await emailBox.uncheck();
    await expect(page.getByText('Preferences saved').first()).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Mentions Email')).not.toBeChecked();
    await expect(page.getByLabel('Mentions In-app')).toBeChecked();
  });

  test('sequences enroll a contact with visible status', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const contactName = `Cadence Contact ${id}`;
    await page.goto('/contacts');
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill(contactName);
    await page.getByLabel('Email Address *').fill(`cadence-${id}@example.test`);
    await page.getByRole('button', { name: 'Create Contact', exact: true }).click();
    await expect(page.getByText('Contact created successfully').first()).toBeVisible();

    const sequenceName = `Drip ${id}`;
    await page.goto('/sequences');
    await page.getByRole('button', { name: '+ New Sequence' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(sequenceName);
    await dialog.getByLabel('Subject').fill(`Hello ${id}`);
    await dialog.getByLabel('Body').fill('Just checking in.');
    await dialog.getByRole('button', { name: 'Create Sequence' }).click();
    await expect(page.getByText(`Sequence "${sequenceName}" created`).first()).toBeVisible();

    await page.getByRole('button', { name: sequenceName }).click();
    await page.getByLabel('Contact').selectOption({ label: contactName });
    await page.getByRole('button', { name: 'Enroll' }).click();
    await expect(page.getByText('Contact enrolled').first()).toBeVisible();
    await expect(page.getByText(contactName).first()).toBeVisible();
  });

  test('quotes draft from lines, send, and accept publicly', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const contactName = `Quote Contact ${id}`;
    await page.goto('/contacts');
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill(contactName);
    await page.getByLabel('Email Address *').fill(`quote-${id}@example.test`);
    await page.getByRole('button', { name: 'Create Contact', exact: true }).click();
    await expect(page.getByText('Contact created successfully').first()).toBeVisible();

    const dealName = `Quoted Deal ${id}`;
    await page.goto('/deals');
    await page.getByRole('button', { name: '+ New Deal' }).click();
    await page.getByLabel('Deal name').fill(dealName);
    await page.getByLabel('Amount (USD)').fill('3000');
    await page.getByRole('button', { name: 'Create Deal' }).click();
    await expect(page.getByText(`Deal "${dealName}" created`).first()).toBeVisible();
    await page.getByRole('link', { name: dealName }).click();
    const dealId = page.url().split('/deals/')[1]!;

    // Link the contact so quotes have a recipient, then attach a line.
    await page.getByLabel('Contact').selectOption({ label: contactName });
    await expect(page.getByText('Deal updated').first()).toBeVisible();
    const line = await page.request.post(`${API}/deals/${dealId}/line-items`, {
      data: { name: 'Service block', quantity: 2, unitPrice: 500 },
    });
    expect(line.ok()).toBe(true);

    await page.reload();
    await expect(page.getByRole('heading', { name: dealName })).toBeVisible();
    await page.getByRole('button', { name: 'Draft quote' }).click();
    await expect(page.getByText('Quote drafted from line items').first()).toBeVisible();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Quote sent').first()).toBeVisible();

    const viewLink = page.getByRole('link', { name: 'View link' });
    await expect(viewLink).toBeVisible();
    const href = await viewLink.getAttribute('href');
    expect(href).toContain('/quotes/');

    await page.goto(href!);
    await expect(page.getByText('USD 1,000.00').first()).toBeVisible();
    await page.getByLabel('Your name').fill('Client Person');
    await page.getByRole('button', { name: 'Accept & sign' }).click();
    await expect(page.getByText(/accepted/i).first()).toBeVisible();
  });

  test('forecast exports a CSV download', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/reports');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const path = await download.path();
    const text = readFileSync(path!, 'utf8');
    expect(text).toContain('owner,deals');
  });

  test('call logging captures duration and dials via tel link', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const contactName = `Call Contact ${id}`;
    await page.goto('/contacts');
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill(contactName);
    await page.getByLabel('Email Address *').fill(`call-${id}@example.test`);
    await page.getByLabel('Phone').fill('+1 555-0100');
    await page.getByRole('button', { name: 'Create Contact', exact: true }).click();
    await expect(page.getByText('Contact created successfully').first()).toBeVisible();
    await page.getByRole('link', { name: contactName }).click();
    const phoneLink = page.getByRole('link', { name: '+1 555-0100' });
    await expect(phoneLink).toBeVisible();
    expect(await phoneLink.getAttribute('href')).toBe('tel:+1555-0100');

    await page.goto('/tasks');
    const subject = `Timed call ${id}`;
    await page.getByLabel('Subject').fill(subject);
    await page.getByLabel('Minutes').fill('5');
    await page.getByRole('button', { name: 'Log activity' }).click();
    await expect(page.getByText('Activity logged').first()).toBeVisible();
    const row = page.getByText(subject);
    await expect(row).toBeVisible();
    await expect(page.getByText('5m').first()).toBeVisible();
  });
});
