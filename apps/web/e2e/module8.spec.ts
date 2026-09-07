import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

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

async function createDeal(page: import('@playwright/test').Page, name: string) {
  await page.goto('/deals');
  await page.getByRole('button', { name: '+ New Deal' }).click();
  await page.getByLabel('Deal name').fill(name);
  await page.getByLabel('Amount (USD)').fill('9000');
  await page.getByRole('button', { name: 'Create Deal' }).click();
  await expect(page.getByText(`Deal "${name}" created`).first()).toBeVisible();
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test.describe('Module 8: Collaboration', () => {
  test('deal comments post, edit, and delete', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);
    const dealName = `Commentable Deal ${id}`;
    await createDeal(page, dealName);

    const body = `Strong quarter ahead ${id}`;
    await page.getByLabel('Write a comment').fill(body);
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.getByText('Comment posted').first()).toBeVisible();
    await expect(page.getByText(body)).toBeVisible();

    await page.getByRole('button', { name: 'Edit comment by Nexus Admin' }).click();
    const editor = page.getByLabel('Edit comment', { exact: true });
    await editor.clear();
    await editor.fill(`Revised outlook ${id}`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Comment updated').first()).toBeVisible();
    await expect(page.getByText(`Revised outlook ${id}`)).toBeVisible();

    await page.getByRole('button', { name: 'Delete comment by Nexus Admin' }).click();
    await expect(page.getByText('Comment deleted').first()).toBeVisible();
    await expect(page.getByText(`Revised outlook ${id}`)).toHaveCount(0);
  });

  test('deal attachments upload, download, reject, and delete', async ({ page }, testInfo) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);
    await createDeal(page, `Filey Deal ${id}`);

    const fixture = testInfo.outputPath('brief.txt');
    const content = `deal brief ${id}`;
    writeFileSync(fixture, content);

    await page.locator('input[type="file"]').setInputFiles(fixture);
    await expect(page.getByText('1 file uploaded').first()).toBeVisible();
    const row = page.getByRole('listitem', { name: 'Attachment brief.txt' });
    await expect(row).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('link', { name: 'brief.txt' }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    expect(readFileSync(downloadPath!, 'utf8')).toBe(content);

    const badFixture = testInfo.outputPath('run.exe');
    writeFileSync(badFixture, 'MZ');
    await page.locator('input[type="file"]').setInputFiles(badFixture);
    await expect(page.getByRole('alert')).toContainText(/not accepted/);

    await row.getByRole('button', { name: 'Delete attachment brief.txt' }).click();
    await expect(page.getByText('Attachment deleted').first()).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Attachment brief.txt' })).toHaveCount(0);
  });

  test('contact detail hosts comments and shows them on the timeline', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const contactName = `Collab Contact ${id}`;
    await page.goto('/contacts');
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill(contactName);
    await page.getByLabel('Email Address *').fill(`collab-${id}@example.test`);
    await page.getByRole('button', { name: 'Create Contact', exact: true }).click();
    await expect(page.getByText('Contact created successfully').first()).toBeVisible();

    await page.getByRole('link', { name: contactName }).click();
    await expect(page.getByRole('heading', { name: contactName })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Comments' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Attachments' })).toBeVisible();

    const body = `Met at summit ${id}`;
    await page.getByLabel('Write a comment').fill(body);
    await page.getByRole('button', { name: 'Post comment' }).click();
    await expect(page.getByText('Comment posted').first()).toBeVisible();

    // The comment surfaces on the Activity Timeline tab.
    await expect(page.getByText(`Comment: ${body}`).first()).toBeVisible();
  });
});
