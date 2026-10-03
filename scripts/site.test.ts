import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ATTRIBUTION = 'Free code signing provided by';

describe('the code signing policy exists in both places with the required wording', () => {
  const md = read('docs/code-signing-policy.md');
  const html = read('site/code-signing.html');
  it('carries SignPath\'s attribution sentence', () => {
    expect(md).toContain('Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).');
    expect(html).toContain(ATTRIBUTION);
    expect(html).toContain('certificate by <a href="https://signpath.org">SignPath Foundation</a>');
  });
  it('names the three roles and the privacy statement in both', () => {
    for (const text of [md, html]) for (const word of ['Author', 'Reviewer', 'Approver', 'Privacy', 'multi-factor']) expect(text, word).toContain(word);
  });
  it('is linked from the site footer and the README', () => {
    expect(read('site/index.html')).toContain('href="code-signing.html"');
    expect(read('README.md')).toContain('docs/code-signing-policy.md');
  });
  it('the site only references files that exist', () => {
    for (const page of ['site/index.html', 'site/code-signing.html']) {
      for (const [, src] of read(page).matchAll(/(?:src|href)="(img\/[^"]+)"/g)) expect(() => readFileSync(new URL(`../site/${src}`, import.meta.url)), src).not.toThrow();
    }
  });
});
