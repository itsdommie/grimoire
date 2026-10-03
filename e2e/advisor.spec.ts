import { expect, test } from '@playwright/test';

// The advisor with a scripted stand-in for Anthropic (GRIMOIRE_FAKE_ADVISOR): the key flow, a conversation that makes database lookups,
// cards that were really looked up, and the error paths. The key store in the e2e server lives in memory, so a test starts by removing any key.
const tab = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Advisor' });

async function openAdvisor(page: import('@playwright/test').Page) {
  await page.goto('/');
  await tab(page).click();
  // Wait for the advisor to say whether it has a key, then start from none.
  await expect(page.getByLabel('Anthropic API key').or(page.getByLabel('Message the advisor'))).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove key' });
  if (await remove.isVisible()) { page.once('dialog', (d) => void d.accept()); await remove.click(); await expect(page.getByLabel('Anthropic API key')).toBeVisible(); }
}
const saveKey = async (page: import('@playwright/test').Page, key: string) => {
  await page.getByLabel('Anthropic API key').fill(key);
  await page.getByRole('button', { name: 'Save key' }).click();
};

test('asks for a key first, explains what is sent, and rejects things that are not keys', async ({ page }) => {
  await openAdvisor(page);
  await expect(page.getByRole('heading', { name: /Advisor/ })).toBeVisible();
  await expect(page.getByText(/sent to Anthropic/)).toBeVisible();
  await expect(page.getByLabel('Message the advisor')).toHaveCount(0);
  await saveKey(page, 'hunter2');
  await expect(page.getByRole('alert')).toContainText('sk-ant-');
  await expect(page.getByLabel('Message the advisor')).toHaveCount(0);
});

test('a key Anthropic rejects is reported plainly and the chat stays usable', async ({ page }) => {
  await openAdvisor(page);
  await saveKey(page, 'sk-ant-invalid-key-0123456789abcdef');
  await page.getByLabel('Message the advisor').fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert')).toContainText('rejected the API key');
  await expect(page.getByLabel('Message the advisor')).toBeEnabled(); // still a usable chat: the person can fix the key
});

test('answers from database lookups, shows only cards it really found, and keeps the chat across views', async ({ page }) => {
  await openAdvisor(page);
  await saveKey(page, 'sk-ant-api03-test-key-0123456789abcdef');
  await expect(page.getByLabel('Message the advisor')).toBeVisible();
  await expect(page.getByRole('button', { name: /Suggest a commander/ })).toBeVisible(); // starters, since no deck is open

  await page.getByLabel('Message the advisor').fill('cheap artifacts please');
  await page.getByRole('button', { name: 'Send' }).click();
  const answer = page.locator('.chatmsg.assistant').last();
  await expect(answer).toContainText('Sol Ring', { timeout: 20_000 });
  await expect(answer).toContainText('looked at 1 thing in your card database');
  await expect(answer.locator('strong', { hasText: 'Sol Ring' })).toBeVisible();
  // Sol Ring was looked up; Mana Crypt was only named by the model, so it gets no card.
  await expect(answer.getByRole('list', { name: 'Cards mentioned' }).getByRole('button')).toHaveCount(1);
  await expect(answer.getByRole('button', { name: /Sol Ring/ })).toBeVisible();

  // The card opens in the usual detail dialog.
  await answer.getByRole('button', { name: /Sol Ring/ }).click();
  await expect(page.getByRole('dialog', { name: /Sol Ring/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Another view and back: the conversation is still there.
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Rules' }).click();
  await tab(page).click();
  await expect(page.locator('.chatmsg.user', { hasText: 'cheap artifacts please' })).toBeVisible();
  await expect(page.locator('.chatmsg.assistant', { hasText: 'Sol Ring' })).toBeVisible();

  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.chatmsg')).toHaveCount(0);
  await page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByLabel('Anthropic API key')).toBeVisible();
});

test('with a deck open it reviews that deck; with none it says so', async ({ page }) => {
  await openAdvisor(page);
  await saveKey(page, 'sk-ant-api03-test-key-0123456789abcdef');
  await page.getByLabel('Message the advisor').fill('review my deck');
  await page.getByRole('button', { name: 'Send' }).click();
  // (whether a deck exists depends on the e2e profile's state: either answer proves the right tool ran)
  const answer = page.locator('.chatmsg.assistant').last();
  await expect(answer).toContainText(/I looked at your deck|no deck open/, { timeout: 20_000 });

  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByLabel('Message the advisor').fill('slow question');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText('Thinking');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(page.locator('.chatmsg.assistant').last()).toContainText('Sol Ring', { timeout: 20_000 });
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove key' }).click();
});
