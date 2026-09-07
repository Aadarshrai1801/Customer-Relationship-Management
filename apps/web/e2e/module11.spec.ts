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

test.describe('Module 11: Workflow automation', () => {
  test('contact creation triggers a follow-up task with a logged run', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const flowName = `Welcome flow ${id}`;
    const taskTitle = `Welcome newcomer ${id}`;
    await page.goto('/settings/workflows');
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();

    await page.getByRole('button', { name: '+ New Workflow' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Workflow name').fill(flowName);
    await dialog.getByLabel('Task title').fill(taskTitle);
    await dialog.getByRole('button', { name: 'Create Workflow' }).click();
    await expect(page.getByText(`Workflow "${flowName}" created`).first()).toBeVisible();
    await expect(page.getByRole('listitem', { name: `Workflow ${flowName}` })).toBeVisible();

    const contactName = `Auto Contact ${id}`;
    await page.goto('/contacts');
    await page.getByRole('button', { name: '+ New Contact' }).click();
    await page.getByLabel('Full Name *').fill(contactName);
    await page.getByLabel('Email Address *').fill(`auto-${id}@example.test`);
    await page.getByRole('button', { name: 'Create Contact', exact: true }).click();
    await expect(page.getByText('Contact created successfully').first()).toBeVisible();

    // The rule fires asynchronously: task appears, then the run is logged.
    await page.goto('/tasks');
    await expect(page.getByRole('listitem', { name: `Task ${taskTitle}` })).toBeVisible({
      timeout: 20000,
    });

    await page.goto('/settings/workflows');
    await page
      .getByRole('listitem', { name: `Workflow ${flowName}` })
      .getByRole('button', { name: flowName, exact: true })
      .click();
    await expect(page.getByText('success').first()).toBeVisible({ timeout: 20000 });
  });

  test('pausing a workflow stops automation', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    const flowName = `Pausable flow ${id}`;
    await page.goto('/settings/workflows');
    await page.getByRole('button', { name: '+ New Workflow' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Workflow name').fill(flowName);
    await dialog.getByLabel('Task title').fill(`Should not appear ${id}`);
    await dialog.getByRole('button', { name: 'Create Workflow' }).click();
    await expect(page.getByText(`Workflow "${flowName}" created`).first()).toBeVisible();

    await page.getByRole('button', { name: `Pause workflow ${flowName}` }).click();
    await expect(page.getByText('Workflow updated').first()).toBeVisible();
    await expect(page.getByText('paused').first()).toBeVisible();
  });
});
