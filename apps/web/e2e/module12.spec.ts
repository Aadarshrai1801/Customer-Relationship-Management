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

async function createDeal(page: import('@playwright/test').Page, name: string) {
  await page.goto('/deals');
  await page.getByRole('button', { name: '+ New Deal' }).click();
  await page.getByLabel('Deal name').fill(name);
  await page.getByLabel('Amount (USD)').fill('12000');
  await page.getByRole('button', { name: 'Create Deal' }).click();
  await expect(page.getByText(`Deal "${name}" created`).first()).toBeVisible();
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test.describe('Module 12: Stalled deals, competitors, recurrence', () => {
  test('competitors can be added inline and persist on the deal', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);
    const dealName = `Rivalry Deal ${id}`;
    await createDeal(page, dealName);

    const rivalName = `Rivalry Inc ${id}`;
    await page.getByRole('button', { name: '+ New competitor' }).click();
    await page.getByLabel('New competitor name').fill(rivalName);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('Competitor updated').first()).toBeVisible();
    await expect(page.getByLabel('Competitor')).toHaveValue(/.+/);

    await page.reload();
    await expect(page.getByRole('heading', { name: dealName })).toBeVisible();
    const selected = page.getByLabel('Competitor');
    const selectedText = await selected.locator('option:checked').textContent();
    expect(selectedText).toContain(rivalName);
  });

  test('completing a recurring task spawns the next occurrence', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();

    const title = `Daily sync ${id}`;
    await page.getByRole('button', { name: '+ New Task' }).click();
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Due date').fill('2027-01-05');
    await page.getByLabel('Repeats').selectOption('daily');
    await page.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByText(`Task "${title}" created`).first()).toBeVisible();

    const row = page.getByRole('listitem', { name: `Task ${title}` });
    await expect(row.getByText('repeats daily')).toBeVisible();
    await row.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByText('Task completed').first()).toBeVisible();

    // The completed row leaves Open; the spawned occurrence keeps the badge.
    const next = page.getByRole('listitem', { name: `Task ${title}` });
    await expect(next).toBeVisible();
    await expect(next.getByText('repeats daily')).toBeVisible();
  });

  test('stalled-deals widget renders on dashboards', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);
    await createDeal(page, `Fresh Deal ${id}`);

    await page.goto('/reports');
    await page.getByRole('button', { name: 'Dashboards' }).click();
    await page.getByRole('button', { name: '+ New Dashboard' }).click();
    await page.getByLabel('Name').fill(`Rot board ${id}`);
    await page.getByText('Stalled deals').click();
    await page.getByRole('button', { name: 'Create Dashboard' }).click();
    await expect(page.getByText(/created/).first()).toBeVisible();

    const widget = page.getByRole('region', { name: 'Widget stalled-deals' });
    await expect(widget).toBeVisible();
    await expect(widget.getByText(/No deals inactive beyond 14 days/)).toBeVisible();
  });
});
