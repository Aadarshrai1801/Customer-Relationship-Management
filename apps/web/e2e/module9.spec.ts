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

test.describe('Module 9: Setup wizard and rate limits', () => {
  test('fresh workspace starts empty and completes steps through real usage', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    // Home surfaces the getting-started card for incomplete workspaces.
    await expect(page.getByText('Getting started')).toBeVisible();
    await page.getByRole('link', { name: 'Continue setup →' }).click();
    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
    await expect(page.getByText('0 of 5 steps done')).toBeVisible();

    // API responses carry rate-limit headers (PRD 4.14).
    const probe = await page.request.get('http://localhost:3001/v1/org');
    expect(probe.ok()).toBe(true);
    expect(probe.headers()['x-ratelimit-limit']).toBe('600');
    expect(Number(probe.headers()['x-ratelimit-remaining'])).not.toBeNaN();

    // First contact completes the contact step.
    const contactName = `First Friend ${id}`;
    await page.goto('/contacts');
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill(contactName);
    await page.getByLabel('Email Address *').fill(`first-${id}@example.test`);
    await page.getByRole('button', { name: 'Create Contact', exact: true }).click();
    await expect(page.getByText('Contact created successfully').first()).toBeVisible();

    await page.goto('/welcome');
    await expect(page.getByText('1 of 5 steps done')).toBeVisible();

    // First deal completes the deal step (pipeline needs a stage move).
    const dealName = `First Deal ${id}`;
    await page.goto('/deals');
    await page.getByRole('button', { name: '+ New Deal' }).click();
    await page.getByLabel('Deal name').fill(dealName);
    await page.getByLabel('Amount (USD)').fill('5000');
    await page.getByRole('button', { name: 'Create Deal' }).click();
    await expect(page.getByText(`Deal "${dealName}" created`).first()).toBeVisible();
    await page.getByRole('link', { name: dealName }).click();
    await expect(page.getByRole('heading', { name: dealName })).toBeVisible();

    await page.getByRole('button', { name: /Proposal/ }).click();
    await expect(page.getByText('Deal stage updated').first()).toBeVisible();

    await page.goto('/welcome');
    await expect(page.getByText('3 of 5 steps done')).toBeVisible();
    const doneBadges = page.getByText('done', { exact: true });
    await expect(doneBadges.first()).toBeVisible();
  });
});
