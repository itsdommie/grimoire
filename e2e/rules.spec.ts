import { expect, test } from '@playwright/test';

const rulesTab = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Rules' });
const box = (page: import('@playwright/test').Page) => page.getByLabel('Search the rules');

test('browse the contents and open a rule group', async ({ page }) => {
  await page.goto('/');
  await rulesTab(page).click();
  const contents = page.getByRole('region', { name: 'Contents' });
  await expect(contents).toContainText('Game Concepts');
  await contents.getByText('Additional Rules').click();
  await contents.getByRole('button', { name: /702 Keyword Abilities/ }).click();
  const page702 = page.getByRole('article', { name: 'Rule 702' });
  await expect(page702).toBeVisible();
  await expect(page702.getByRole('button', { name: 'Open rule 702.19', exact: true })).toBeVisible(); // Trample is one of its rules
  await page702.getByRole('button', { name: 'Open rule 702.19', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Rule 702.19' })).toContainText('Trample');
});

test('search finds the glossary entry and its rules; cross-references and breadcrumbs navigate', async ({ page }) => {
  await page.goto('/');
  await rulesTab(page).click();
  await box(page).fill('trample');
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(results.getByRole('heading', { name: 'Glossary' })).toBeVisible();
  await expect(results.locator('.glossary li').first()).toContainText('Trample');
  await results.getByRole('button', { name: /Read rule 702\.19/ }).first().click();

  const rule = page.getByRole('article', { name: 'Rule 702.19' });
  await expect(rule.getByRole('navigation', { name: 'Where this rule sits' })).toContainText('702');
  await expect(rule).toContainText('Trample is a static ability'); // 702.19a, listed under the rule
  // A "rule 510" reference inside the text is a link to that rule.
  await rule.getByRole('button', { name: '510', exact: true }).first().click();
  await expect(page.getByRole('article', { name: 'Rule 510' })).toContainText('Combat Damage Step');
  // Open one of its rules, then use the breadcrumb to go back up to the group.
  await page.getByRole('article', { name: 'Rule 510' }).getByRole('button', { name: 'Open rule 510.1', exact: true }).click();
  await page.getByRole('navigation', { name: 'Where this rule sits' }).getByRole('button', { name: /^510 Combat Damage Step/ }).click();
  await expect(page.getByRole('article', { name: 'Rule 510' })).toBeVisible();
});

test('a rule number jumps straight to that rule; plain-English questions work; nonsense is explained', async ({ page }) => {
  await page.goto('/');
  await rulesTab(page).click();
  await box(page).fill('704.5a');
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(results.locator('.rulehit').first()).toContainText('0 or less life');
  await results.locator('.rulehit').first().click();
  await expect(page.getByRole('article', { name: 'Rule 704.5a' })).toContainText('loses the game');

  await box(page).fill('what happens when a creature dies');
  await expect(page.getByRole('region', { name: 'Search results' }).locator('.rulehit').first()).toBeVisible();

  await box(page).fill('zzqqxx');
  await expect(page.getByRole('region', { name: 'Search results' })).toContainText('Nothing matches');
});

test('a card\'s keywords are explained, with a link into the rules', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder(/Search/).fill('!"serra angel"');
  await page.getByRole('button', { name: 'Details for Serra Angel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Serra Angel details' });
  const flying = dialog.getByRole('region', { name: 'Keywords' }).locator('details', { hasText: 'Flying' });
  await flying.getByText('Flying', { exact: true }).click();
  await expect(flying).toContainText('may be blocked'); // the glossary definition
  await flying.getByRole('button', { name: /Read rule 702\.9/ }).click();
  await expect(page.getByRole('article', { name: 'Rule 702.9' })).toContainText('Flying');
  await expect(dialog).toHaveCount(0);
});
