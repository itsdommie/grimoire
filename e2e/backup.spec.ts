import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('back up, wipe, and restore decks and collection', async ({ page }, testInfo) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');

  // Build some user data: a deck and a few owned cards.
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('dialog').locator('textarea').fill('Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n1 Cultivate');
  await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('.deck .rname', { hasText: 'Sol Ring' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  const imp = page.getByRole('dialog', { name: 'Import collection' });
  await imp.getByLabel('Collection data').fill('2 Sol Ring\n1 Rhystic Study');
  await imp.getByRole('radio', { name: 'Replace my collection' }).check();
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await imp.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.collbar')).toContainText('3 cards · 2 unique');

  // Back up.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Back up to a file' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^brewhall-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const file = testInfo.outputPath('backup.json');
  await download.saveAs(file);
  const backup = JSON.parse(await readFile(file, 'utf8'));
  expect(backup.decks.some((d: { cards: Array<{ name: string }> }) => d.cards.some((c) => c.name === 'Sol Ring'))).toBe(true);
  expect(backup.collection.map((c: { name: string; qty: number }) => `${c.name}:${c.qty}`).sort()).toEqual(['Rhystic Study:1', 'Sol Ring:2']);

  // Wipe the collection and the deck.
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText('Your collection is empty.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();

  // A non-backup file is refused with a clear message.
  await page.getByRole('button', { name: 'Restore from a file…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore from backup' });
  const junk = join(tmpdir(), 'not-a-backup.json');
  await writeFile(junk, '{"hello": "world"}');
  await dialog.locator('input[type=file]').setInputFiles(junk);
  await expect(dialog.getByRole('alert')).toContainText("doesn't look like a Brewhall backup");
  await expect(dialog.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();

  // The real one: preview counts, replace needs an explicit confirmation.
  await dialog.locator('input[type=file]').setInputFiles(file);
  await expect(dialog).toContainText('3 collection cards');
  await dialog.getByRole('radio', { name: 'Replace everything' }).check();
  await expect(dialog.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  await dialog.getByLabel(/I understand this deletes/).check();
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(dialog).toContainText(/Restored \d+ decks? and 3 collection cards/);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // Everything is back.
  await expect(page.locator('.collbar')).toContainText('3 cards · 2 unique');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Cards' }).click();
  await expect(page.locator('.deck .row button.rname', { hasText: 'Sol Ring' })).toBeVisible();
  await expect(page.locator('.deck .row button.rname', { hasText: "Atraxa, Praetors' Voice" })).toBeVisible();

  // Leave a clean slate for other specs.
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Collection' }).click();
  await page.getByRole('button', { name: 'Clear' }).click();
});
