import { expect, test } from '@playwright/test';
import { generateSync } from 'otplib';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function tag(): string {
  return randomBytes(4).toString('hex');
}

async function signup(page: import('@playwright/test').Page, email: string, orgName: string) {
  await page.goto('/signup');
  await page.getByLabel('Workspace name').fill(orgName);
  await page.getByLabel('Your name').fill('E2E Owner');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-12');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: /Good to see you/ })).toBeVisible();
}

test('signup creates a workspace and lands on home', async ({ page }) => {
  const id = tag();
  await signup(page, `owner-${id}@e2e.test`, `E2E Org ${id}`);
  await expect(page.getByText(`E2E Org ${id}`).first()).toBeVisible();
});

test('login and logout round-trip', async ({ page }) => {
  const id = tag();
  await signup(page, `owner-${id}@e2e.test`, `E2E Org ${id}`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Nexus' })).toBeVisible();

  await page.getByLabel('Email', { exact: true }).fill(`owner-${id}@e2e.test`);
  await page.getByLabel('Password').fill('e2e-password-12');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Good to see you/ })).toBeVisible();
});

test('two-factor setup, verify at login, and status on home', async ({ page }) => {
  const id = tag();
  await signup(page, `owner-${id}@e2e.test`, `E2E Org ${id}`);

  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.locator('p.font-mono').first().innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]+$/);
  await page.getByLabel('Authentication code').fill(generateSync({ secret }));
  await page.getByRole('button', { name: 'Enable 2FA' }).click();
  await expect(page.getByText('Backup codes — save these now')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email', { exact: true }).fill(`owner-${id}@e2e.test`);
  await page.getByLabel('Password').fill('e2e-password-12');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
  await page.getByLabel('Authentication code').fill(generateSync({ secret }));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: /Good to see you/ })).toBeVisible();
  await expect(page.getByText('On', { exact: true }).first()).toBeVisible();
});

test('org security policy change is enforced and visible', async ({ page }) => {
  const id = tag();
  await signup(page, `owner-${id}@e2e.test`, `E2E Org ${id}`);
  await page.goto('/settings/org');
  await page.getByLabel('Two-factor policy').selectOption('required');
  await expect(page.getByText('Security policy updated')).toBeVisible();
  await expect(page.getByText('required').first()).toBeVisible();
});

test('audit log viewer lists workspace activity', async ({ page }) => {
  const id = tag();
  await signup(page, `owner-${id}@e2e.test`, `E2E Org ${id}`);
  await page.goto('/settings/audit');
  await expect(page.getByText('user.created').first()).toBeVisible();
  await page.getByLabel('Action').fill('org.created');
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page.getByText('org.created').first()).toBeVisible();
});

test('privacy export downloads a personal data package', async ({ page }) => {
  const id = tag();
  const userEmail = `owner-${id}@e2e.test`;
  await signup(page, userEmail, `E2E Org ${id}`);
  await page.goto('/settings/privacy');
  await page.getByRole('button', { name: 'Request export' }).click();
  await expect(page.getByText('pending').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('ready').first()).toBeVisible({ timeout: 60_000 });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const pkg = JSON.parse(await readFile(path!, 'utf8')) as {
    user: { email: string };
    sessions: unknown[];
  };
  expect(pkg.user.email).toBe(userEmail);
  expect(pkg.sessions.length).toBeGreaterThanOrEqual(1);
});

test('dark mode toggles and persists', async ({ page }) => {
  const id = tag();
  await signup(page, `owner-${id}@e2e.test`, `E2E Org ${id}`);
  const html = page.locator('html');
  await page.getByRole('button', { name: 'Toggle dark mode' }).click();
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await expect(page.getByRole('heading', { name: /Good to see you/ })).toBeVisible();
});
