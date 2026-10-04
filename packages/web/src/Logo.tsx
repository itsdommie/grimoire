import { useId } from 'react';

/** The Grimoire mark: a gold-framed spellbook with a sigil and a glowing jewel. (The same drawing as brand/grimoire-mark.svg; the ids are unique per use.) */
export function LogoMark({ size = 32 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  const g = (n: string) => `${n}-${id}`;
  const url = (n: string) => `url(#${g(n)})`;
  return (
    <svg className="logomark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
      <linearGradient id={g('cover')} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#6252c4"/><stop offset=".5" stopColor="#372b82"/><stop offset="1" stopColor="#1b1445"/>
      </linearGradient>
      <radialGradient id={g('sheen')} cx=".28" cy=".16" r=".75">
      <stop offset="0" stopColor="#fff" stopOpacity=".26"/><stop offset="1" stopColor="#fff" stopOpacity="0"/>
      </radialGradient>
      <linearGradient id={g('spine')} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stopColor="#150f36"/><stop offset=".7" stopColor="#271e5c"/><stop offset="1" stopColor="#1d1648"/>
      </linearGradient>
      <linearGradient id={g('gold')} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#fff2c2"/><stop offset=".5" stopColor="#e6bb58"/><stop offset="1" stopColor="#9a6b1c"/>
      </linearGradient>
      <linearGradient id={g('pages')} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stopColor="#d9cfb6"/><stop offset="1" stopColor="#fbf4de"/>
      </linearGradient>
      <radialGradient id={g('aura')} cx="32" cy="32" r="31" gradientUnits="userSpaceOnUse">
      <stop offset="0" stopColor="#9a86ff" stopOpacity=".42"/><stop offset=".6" stopColor="#7a66f0" stopOpacity=".14"/><stop offset="1" stopColor="#7a66f0" stopOpacity="0"/>
      </radialGradient>
      <radialGradient id={g('jewel')} cx=".4" cy=".35" r=".7">
      <stop offset="0" stopColor="#e9fff7"/><stop offset=".45" stopColor="#6fe3c1"/><stop offset="1" stopColor="#1f9c84"/>
      </radialGradient>
      <path id={g('star')} d="M0-9.6 1.9-1.9 9.6 0 1.9 1.9 0 9.6-1.9 1.9-9.6 0-1.9-1.9Z"/>
      </defs>
      <g transform="translate(0 0)">
      <circle cx="32" cy="32" r="31" fill={url('aura')}/>
      <rect x="15.2" y="8.4" width="36.2" height="50" rx="3" fill={url('pages')}/>
      <path d="M50 11v44M50.7 11.4v43.4M17 57.1h31.5M17.6 57.8h30.9" fill="none" stroke="#a79b7c" strokeWidth=".35" opacity=".8"/>
      <rect x="12.8" y="5.8" width="36" height="50" rx="3" fill={url('cover')}/>
      <rect x="12.8" y="5.8" width="36" height="50" rx="3" fill={url('sheen')}/>
      <path d="M15.8 5.8h3.2v50h-3.2a3 3 0 0 1-3-3v-44a3 3 0 0 1 3-3Z" fill={url('spine')}/>
      <rect x="12.8" y="12.8" width="6.2" height="1.5" rx=".6" fill={url('gold')}/>
      <rect x="12.8" y="29.6" width="6.2" height="1.5" rx=".6" fill={url('gold')}/>
      <rect x="12.8" y="46.4" width="6.2" height="1.5" rx=".6" fill={url('gold')}/>
      <path d="M19.2 6.4v49" stroke="#0d0824" strokeOpacity=".55" strokeWidth=".7"/><path d="M19.8 6.4v49" stroke="#fff" strokeOpacity=".09" strokeWidth=".5"/>
      <rect x="22" y="10.2" width="24.4" height="41.2" rx="1.6" fill="none" stroke={url('gold')} strokeWidth="1"/>
      <rect x="23.5" y="11.7" width="21.4" height="38.2" rx="1" fill="none" stroke="#e6bb58" strokeOpacity=".42" strokeWidth=".5"/>
      <g fill={url('gold')}>
      <path d="M22 8.6l1.5 1.6-1.5 1.6-1.5-1.6Z"/><path d="M46.4 8.6l1.5 1.6-1.5 1.6-1.5-1.6Z"/>
      <path d="M22 49.8l1.5 1.6-1.5 1.6-1.5-1.6Z"/><path d="M46.4 49.8l1.5 1.6-1.5 1.6-1.5-1.6Z"/>
      </g>
      <g transform="translate(34.2 30.8)">
      <circle r="7.4" fill="none" stroke={url('gold')} strokeWidth="1"/>
      <circle r="9.6" fill="none" stroke="#e6bb58" strokeOpacity=".3" strokeWidth=".4" strokeDasharray=".6 1.4"/>
      <use href={'#' + g('star')} fill={url('gold')}/>
      <use href={'#' + g('star')} fill="#fff2c2" opacity=".9" transform="rotate(45) scale(.52)"/>
      <circle r="3.4" fill="#6fe3c1" opacity=".22"/>
      <circle r="1.7" fill={url('jewel')}/>
      <circle cx="-.5" cy="-.6" r=".45" fill="#fff"/>
      </g>
      <path d="M54.6 13l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9Z" fill="#ffe9a8"/>
      <path d="M8.6 47.4l.65 1.8 1.8.65-1.8.65-.65 1.8-.65-1.8-1.8-.65 1.8-.65Z" fill="#ffe9a8" opacity=".85"/>
      <circle cx="57.4" cy="24.6" r=".7" fill="#b9a8ff"/><circle cx="6.8" cy="19.6" r=".6" fill="#b9a8ff" opacity=".8"/><circle cx="52.4" cy="52.6" r=".5" fill="#b9a8ff" opacity=".7"/>
      </g>
    </svg>
  );
}

/** The mark and the name, as in the top bar. */
export function Logo({ size = 42 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="wordmark">Grimoire</span>
    </span>
  );
}
