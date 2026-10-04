import { useId } from 'react';

/** The Brewhall mark: a tankard of beer, foam spilling over the rim. (The same drawing as brand/brewhall-mark.svg; the ids are unique per use.) */
export function LogoMark({ size = 32 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  const g = (n: string) => `${n}-${id}`;
  const url = (n: string) => `url(#${g(n)})`;
  return (
    <svg className="logomark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
      <linearGradient id={g('beer')} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#ffd884"/><stop offset=".42" stopColor="#f2a238"/><stop offset="1" stopColor="#b8541a"/>
      </linearGradient>
      <linearGradient id={g('beerside')} x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stopColor="#7a2f0c" stopOpacity=".55"/><stop offset=".3" stopColor="#7a2f0c" stopOpacity="0"/><stop offset=".78" stopColor="#7a2f0c" stopOpacity="0"/><stop offset="1" stopColor="#5a1f06" stopOpacity=".6"/>
      </linearGradient>
      <linearGradient id={g('brass')} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#ffe2a6"/><stop offset=".45" stopColor="#e8913a"/><stop offset="1" stopColor="#9a4a16"/>
      </linearGradient>
      <linearGradient id={g('handle')} gradientUnits="userSpaceOnUse" x1="0" y1="26" x2="0" y2="54">
      <stop offset="0" stopColor="#ffd58f"/><stop offset=".5" stopColor="#d9782a"/><stop offset="1" stopColor="#8f4416"/>
      </linearGradient>
      <linearGradient id={g('foam')} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#fffdf6"/><stop offset=".6" stopColor="#fff0cf"/><stop offset="1" stopColor="#f3d08e"/>
      </linearGradient>
      <radialGradient id={g('glow')} cx="26" cy="38" r="26" gradientUnits="userSpaceOnUse">
      <stop offset="0" stopColor="#ff9d3d" stopOpacity=".34"/><stop offset="1" stopColor="#ff9d3d" stopOpacity="0"/>
      </radialGradient>
      <linearGradient id={g('foamshade')} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#6b2a08" stopOpacity=".5"/><stop offset="1" stopColor="#6b2a08" stopOpacity="0"/>
      </linearGradient>
      <clipPath id={g('vessel')}><path d="M12.5 22H39.5L42.5 53.6Q42.7 56.6 39.7 56.6H12.3Q9.3 56.6 9.5 53.6Z"/></clipPath>
      </defs>
      <g transform="translate(6 .8)"><ellipse cx="30" cy="36" rx="28" ry="26" fill={url('glow')}/>
      <path d="M40.6 30.4H46.2a6.8 6.8 0 0 1 6.8 6.8v5.4a6.8 6.8 0 0 1-6.8 6.8H41.4" fill="none" stroke={url('handle')} strokeWidth="4.4" strokeLinecap="round"/>
      <path d="M46.4 28.7a8.4 8.4 0 0 1 8.2 8.5" fill="none" stroke="#fff" strokeOpacity=".28" strokeWidth=".9" strokeLinecap="round"/>
      <path d="M12.5 22H39.5L42.5 53.6Q42.7 56.6 39.7 56.6H12.3Q9.3 56.6 9.5 53.6Z" fill={url('beer')}/>
      <g clipPath={url('vessel')}>
      <rect x="0" y="0" width="64" height="64" fill={url('beerside')}/>
      <rect x="0" y="22" width="64" height="8" fill={url('foamshade')}/>
      <rect x="15" y="27" width="2.6" height="26" rx="1.3" fill="#fff" opacity=".34"/>
      <rect x="19" y="33" width="1.2" height="12" rx=".6" fill="#fff" opacity=".2"/>
      <circle cx="30.5" cy="44" r="1.15" fill="#fff" opacity=".4"/><circle cx="34" cy="38.5" r=".8" fill="#fff" opacity=".35"/><circle cx="27" cy="36" r=".7" fill="#fff" opacity=".3"/><circle cx="35.5" cy="47.5" r=".9" fill="#fff" opacity=".3"/><circle cx="24.5" cy="48" r=".6" fill="#fff" opacity=".3"/>
      </g>
      <rect x="11.4" y="25.6" width="29.2" height="3.3" rx="1.2" fill={url('brass')}/>
      <rect x="10.6" y="48.6" width="30.8" height="3.3" rx="1.2" fill={url('brass')}/>
      <rect x="12.6" y="26.1" width="25" height=".8" rx=".4" fill="#fff" opacity=".35"/>
      <rect x="11.8" y="49.1" width="26.6" height=".8" rx=".4" fill="#fff" opacity=".3"/>
      <g>
      <path d="M10.8 21.4C9.4 25.4 9.2 29.8 10.4 32.4c1 2.2 3.8 1.9 4-.6.1-2.8-.5-5.6-.5-9.5Z" fill={url('foam')}/>
      <path d="M22.8 22c-.5 3.6-.2 6.6.8 8.1 1 1.5 3.2.9 3.2-1 0-2.3-.9-4.4-.9-7.1Z" fill={url('foam')}/>
      <path d="M38.4 21.8c1.5 3.4 2.2 7 1.9 9.4-.3 2.2-2.9 2.3-3.5.2-.5-2 0-5.4-.2-9.6Z" fill={url('foam')}/>
      <rect x="9.6" y="17.6" width="32" height="6.4" rx="3.2" fill={url('foam')}/>
      <circle cx="13.8" cy="19.2" r="4.4" fill={url('foam')}/>
      <circle cx="19.6" cy="15.7" r="5.5" fill={url('foam')}/>
      <circle cx="26.6" cy="13.6" r="6.4" fill={url('foam')}/>
      <circle cx="33.6" cy="15.9" r="5.5" fill={url('foam')}/>
      <circle cx="38.6" cy="19.6" r="4.2" fill={url('foam')}/>
      <path d="M9.8 21.2c3 1.6 6 1.1 8.6-.3 3.1 1.8 6.6 1.9 9.6.2 3.2 1.6 6.4 1.7 9.2.1" fill="none" stroke="#e7b86c" strokeOpacity=".55" strokeWidth=".7" strokeLinecap="round"/>
      <circle cx="21.6" cy="14.2" r="1.3" fill="#fff"/><circle cx="29" cy="11.4" r="1.6" fill="#fff"/><circle cx="35.4" cy="14" r="1.1" fill="#fff"/><circle cx="16" cy="17.2" r=".9" fill="#fff"/>
      </g>
      <circle cx="32.8" cy="7.4" r="1.2" fill="#fff3cf" opacity=".85"/><circle cx="23.4" cy="6.6" r=".8" fill="#ffe3a8" opacity=".8"/><circle cx="37.6" cy="10.2" r=".7" fill="#ffe3a8" opacity=".7"/>
      <ellipse cx="26" cy="59.6" rx="21" ry="2" fill="#000" opacity=".28"/>
      </g>
    </svg>
  );
}

/** The mark and the name, as in the top bar. */
export function Logo({ size = 42 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="wordmark"><span className="wm-brew">Brew</span><span className="wm-hall">hall</span></span>
    </span>
  );
}
