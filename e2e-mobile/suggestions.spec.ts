import { expect, test } from './fixtures';

// "Ideas from your collection" on the on-device database (SQLite WASM): the colour-identity bitmask, legality join and spare-copy maths
// all run there, so check them there. Set up through the app's own API (window.fetch is bridged to the on-device router).
test('a deck suggests owned cards that fit it, by role', async ({ page }) => {
  test.setTimeout(180_000);
  if (!process.env.ANDROID_APP) await page.goto('/');
  await expect(page.getByPlaceholder(/Search/)).toBeVisible({ timeout: 90_000 });
  const out = await page.evaluate(async () => {
    const post = async (url: string, data: unknown) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })).json();
    await post('/api/collection/import', { text: "1 Cultivate\n1 Sol Ring\n1 Lightning Bolt", mode: 'merge' });
    const deck = await post('/api/decks/import', { text: 'Commander\n1 Titania, Protector of Argoth\nDeck\n', name: 'Phone suggestions', format: 'commander' });
    const s = await (await fetch(`/api/decks/${deck.deck.id}/suggestions`)).json();
    return { id: deck.deck.id as number, needsMore: s.needsMore as boolean, ramp: (s.roles.find((r: { role: string }) => r.role === 'ramp')?.cards ?? []).map((c: { name: string }) => c.name) as string[], all: s.roles.flatMap((r: { cards: Array<{ name: string }> }) => r.cards.map((c) => c.name)) as string[] };
  });
  expect(out.needsMore).toBe(false);
  expect(out.ramp).toEqual(expect.arrayContaining(['Cultivate', 'Sol Ring']));
  expect(out.all).not.toContain('Lightning Bolt'); // red, outside Titania's colours
});
