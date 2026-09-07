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

async function syncInbound(page: import('@playwright/test').Page, from: string, subject: string) {
  await page.getByLabel('Sender email').fill(from);
  await page.getByPlaceholder('Hello from the field').fill(subject);
  await page.getByRole('button', { name: 'Sync test email' }).click();
  await expect(page.getByText('Inbound email synced').first()).toBeVisible();
}

test.describe('Module 6: Email Integration & Auto-logging', () => {
  test('inbound sync queues unmatched senders and converts to contact', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/emails');
    await expect(page.getByRole('heading', { name: 'Emails', exact: true })).toBeVisible();

    const from = `prospect-${id}@example.test`;
    const subject = `Field hello ${id}`;
    await syncInbound(page, from, subject);

    // Appears in the log as unmatched and in the suggestions queue.
    const row = page.getByRole('listitem', { name: `Email ${subject}` });
    await expect(row.getByText('unmatched')).toBeVisible();
    await expect(page.getByText('1 unmatched sender')).toBeVisible();

    // Convert prompts for a name and creates the contact.
    await page.getByRole('button', { name: 'Log as new contact' }).click();
    await page.getByLabel('Contact name').fill(`Pip Prospect ${id}`);
    await page.getByRole('button', { name: 'Create contact' }).click();
    await expect(page.getByText('Contact created from email').first()).toBeVisible();
    await expect(page.getByText('unmatched sender')).toHaveCount(0);

    // The new contact exists with the sender address.
    await page.goto('/contacts');
    await expect(page.getByText(`Pip Prospect ${id}`).first()).toBeVisible();
  });

  test('templates render and compose sends with auto-logging', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/emails');
    await expect(page.getByRole('heading', { name: 'Emails', exact: true })).toBeVisible();

    const templateName = `Intro ${id}`;
    await page.getByLabel('Template name').fill(templateName);
    await page.getByPlaceholder('Hi {{contactName}}', { exact: true }).fill(`Hello ${id}`);
    await page.getByLabel('Body').fill('Hi {{contactName}}, this is {{ownerName}}.');
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText('Template created').first()).toBeVisible();
    await expect(page.getByText(templateName)).toBeVisible();

    // Duplicate names are rejected.
    await page.getByLabel('Template name').fill(templateName);
    await page.getByPlaceholder('Hi {{contactName}}', { exact: true }).fill('Other');
    await page.getByLabel('Body').fill('Other body.');
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page.getByText(/already exists/i).first()).toBeVisible();

    // Compose with the template and send.
    await page.getByRole('button', { name: '+ Compose' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('To').fill(`buyer-${id}@example.test`);
    await dialog.getByLabel('Template (optional)').selectOption({ label: templateName });
    await expect(dialog.getByLabel('Subject')).toHaveValue(`Hello ${id}`);
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByText('Email sent and logged').first()).toBeVisible();

    // Outbound mail is logged with direction badge.
    const sentRow = page.getByRole('listitem', { name: `Email Hello ${id}` });
    await expect(sentRow.getByText('outbound', { exact: true })).toBeVisible();
  });

  test('direction tabs split inbound and outbound', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/emails');
    const inboundSubject = `Inbound note ${id}`;
    await syncInbound(page, `writer-${id}@example.test`, inboundSubject);

    await page.getByRole('button', { name: '+ Compose' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('To').fill(`buyer-${id}@example.test`);
    await dialog.getByLabel('Subject').fill(`Outbound note ${id}`);
    await dialog.getByLabel('Body').fill('Following up.');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByText('Email sent and logged').first()).toBeVisible();

    await page.getByRole('button', { name: 'Outbound', exact: true }).click();
    await expect(page.getByRole('listitem', { name: `Email Outbound note ${id}` })).toBeVisible();
    await expect(page.getByRole('listitem', { name: `Email ${inboundSubject}` })).toHaveCount(0);

    await page.getByRole('button', { name: 'Inbound', exact: true }).click();
    await expect(page.getByRole('listitem', { name: `Email ${inboundSubject}` })).toBeVisible();
    await expect(page.getByRole('listitem', { name: `Email Outbound note ${id}` })).toHaveCount(0);
  });

  test('converted contact timeline shows the email', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/emails');
    const from = `timeline-${id}@example.test`;
    const subject = `Timeline mail ${id}`;
    await syncInbound(page, from, subject);

    await page.getByRole('button', { name: 'Log as new contact' }).click();
    await page.getByLabel('Contact name').fill(`Tina Timeline ${id}`);
    await page.getByRole('button', { name: 'Create contact' }).click();
    await expect(page.getByText('Contact created from email').first()).toBeVisible();

    await page.goto('/contacts');
    await page.getByText(`Tina Timeline ${id}`).first().click();
    await expect(page.getByRole('heading', { name: `Tina Timeline ${id}` })).toBeVisible();
    await expect(page.getByText(subject).first()).toBeVisible();
  });
});
