export type ThemeChoice = 'auto' | 'dark' | 'light';
const KEY = 'grimoire.theme'; // (the key keeps its old name so that a choice made before the rename is kept)

export function savedTheme(): ThemeChoice {
  try { const v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : 'auto'; } catch { return 'auto'; }
}

/** At start-up: show the saved choice (nothing to write). */
export function initTheme(root: HTMLElement = document.documentElement): void {
  const c = savedTheme();
  if (c !== 'auto') root.setAttribute('data-theme', c);
}

/** Put the choice on the page: the stylesheet follows the system unless `data-theme` says otherwise. */
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', choice);
  try { if (choice === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch { /* storage unavailable: it just won't be remembered */ }
}
