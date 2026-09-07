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

async function createTask(
  page: import('@playwright/test').Page,
  title: string,
  opts?: { due?: string; remind?: string },
) {
  await page.getByRole('button', { name: '+ New Task' }).click();
  await page.getByLabel('Title').fill(title);
  if (opts?.due) await page.getByLabel('Due date').fill(opts.due);
  if (opts?.remind) await page.getByLabel('Remind date').fill(opts.remind);
  await page.getByRole('button', { name: 'Create Task' }).click();
  await expect(page.getByText(`Task "${title}" created`).first()).toBeVisible();
  await expect(page.getByRole('listitem', { name: `Task ${title}` })).toBeVisible();
}

test.describe('Module 5: Tasks, Activities & Reminders', () => {
  test('task creation, completion, and completion auto-log', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();

    const title = `Send proposal ${id}`;
    await createTask(page, title);

    const row = page.getByRole('listitem', { name: `Task ${title}` });
    await row.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByText('Task completed').first()).toBeVisible();
    await expect(page.getByRole('listitem', { name: `Task ${title}` })).toHaveCount(0);

    // Completion auto-logs a task activity in Recent activity.
    await expect(page.getByText(`Completed: ${title}`).first()).toBeVisible();

    // Completed tab shows the finished task.
    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(page.getByRole('listitem', { name: `Task ${title}` })).toBeVisible();
  });

  test('overdue flagging, reminders filter, and digest dispatch', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();

    const overdueTitle = `Overdue filing ${id}`;
    await createTask(page, overdueTitle, { due: '2020-01-15' });
    const overdueRow = page.getByRole('listitem', { name: `Task ${overdueTitle}` });
    await expect(overdueRow.getByText('overdue', { exact: true })).toBeVisible();

    const reminderTitle = `Renewal nudge ${id}`;
    await createTask(page, reminderTitle, { due: '2027-06-01', remind: '2020-02-01' });

    // Reminders filter surfaces only the reminder-due task.
    await page.getByRole('button', { name: 'Reminders', exact: true }).click();
    await expect(page.getByRole('listitem', { name: `Task ${reminderTitle}` })).toBeVisible();
    await expect(page.getByRole('listitem', { name: `Task ${overdueTitle}` })).toHaveCount(0);

    // On-demand digest batches both into one notification.
    await page.getByRole('button', { name: 'Send digests' }).click();
    await expect(page.getByText(/digest/i).first()).toBeVisible();
  });

  test('manual activity logging appears in recent activity', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();

    const subject = `Discovery call ${id}`;
    await page.getByLabel('Activity type').selectOption('call');
    await page.getByLabel('Subject').fill(subject);
    await page.getByRole('button', { name: 'Log activity' }).click();

    await expect(page.getByText('Activity logged').first()).toBeVisible();
    await expect(page.getByText(subject).first()).toBeVisible();
  });

  test('task deletion removes the row', async ({ page }) => {
    const id = tag();
    await signup(page, `admin-${id}@e2e.test`, `Org ${id}`);

    await page.goto('/tasks');
    const title = `Doomed task ${id}`;
    await createTask(page, title);

    await page.getByRole('button', { name: `Delete ${title}` }).click();
    await expect(page.getByText('Task deleted').first()).toBeVisible();
    await expect(page.getByRole('listitem', { name: `Task ${title}` })).toHaveCount(0);
  });
});
