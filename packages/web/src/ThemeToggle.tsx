import { useState } from 'react';
import { Icon, type IconName } from './icons';
import { applyTheme, savedTheme, type ThemeChoice } from './theme';

const CHOICES: Array<[ThemeChoice, string, IconName]> = [['auto', 'Auto', 'auto'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']];

/** Footer control: follow the system's light/dark setting, or choose one. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(savedTheme);
  return (
    <span className="themetoggle">
      <span>Theme</span>
      <span className="seg" role="group" aria-label="Theme">
        {CHOICES.map(([id, label, icon]) => (
          <button key={id} className={choice === id ? 'active' : ''} aria-pressed={choice === id} onClick={() => { setChoice(id); applyTheme(id); }}><Icon name={icon} size={14} />{label}</button>
        ))}
      </span>
    </span>
  );
}
