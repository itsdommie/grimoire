import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// Syncing through a folder on the real server (the Google route needs a Google account, so it is covered by unit tests against a fake
// Drive). Set up from the footer, see the file appear, sync a change, and turn it off. The e2e database is shared, so this cleans up.
test('set up sync with a folder, sync a change, and turn it off', async ({ page, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'brewhall-sync-e2e-'));
  try {
    await page.goto('/');
    const footer = page.locator('.syncfooter');
    await expect(footer).toContainText('Sync between devices: off');
    await footer.getByRole('button', { name: 'Set up…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Sync between devices' });
    await expect(dialog).toContainText('decks, collection and wishlist');
    await expect(dialog).toContainText("Google sign-in isn't set up in this build yet"); // honest about what this build can do
    await expect(dialog.getByRole('button', { name: 'Use this folder' })).toBeDisabled();

    // A folder that is not there is refused with a reason, and nothing is connected.
    await dialog.getByLabel('Folder path').fill(join(dir, 'nope'));
    await dialog.getByRole('button', { name: 'Use this folder' }).click();
    await expect(dialog.getByRole('alert')).toContainText("doesn't exist");
    await dialog.getByLabel('Folder path').fill(dir);
    await dialog.getByRole('button', { name: 'Use this folder' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(footer).toContainText('with the folder');
    await expect(footer).toContainText(/last synced just now/);
    expect(existsSync(join(dir, 'brewhall-sync.json'))).toBe(true);

    // A change here reaches the shared file on the next sync.
    const cards = (await (await request.get('/api/cards/search?q=!%22sol%20ring%22')).json()) as { cards: Array<{ id: string }> };
    const id = cards.cards[0]!.id;
    expect((await request.put('/api/wishlist', { data: { cardId: id, want: 2 } })).ok()).toBe(true);
    await footer.getByRole('button', { name: 'Sync now' }).click();
    await expect(footer).toContainText(/last synced just now/);
    await expect.poll(() => readFileSync(join(dir, 'brewhall-sync.json'), 'utf8')).toContain(id);
    expect(JSON.parse(readFileSync(join(dir, 'brewhall-sync.json'), 'utf8')).items.some((i: { kind: string; key: string }) => i.kind === 'wish' && i.key === id)).toBe(true);

    page.once('dialog', (d) => void d.accept());
    await footer.getByRole('button', { name: 'Turn off' }).click();
    await expect(footer).toContainText('Sync between devices: off');
  } finally {
    await request.delete('/api/sync');
    await request.delete('/api/wishlist');
  }
});
