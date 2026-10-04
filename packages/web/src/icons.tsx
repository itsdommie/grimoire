import type { ReactNode } from 'react';

// A small set of line icons, drawn for Grimoire on a 24-unit grid (1.75 stroke, round caps) so they sit together. They take the colour of
// the text around them, and are decoration: the words next to them carry the meaning (so they are hidden from screen readers).
const P: Record<string, ReactNode> = {
  // a card with the same diamond as the logo
  cards: <><rect x="5.5" y="3" width="13" height="18" rx="2.6" /><path d="M12 8.2l2.7 3.8-2.7 3.8-2.7-3.8z" /></>,
  collection: <><path d="M5.5 8V6.6a2.1 2.1 0 0 1 2.1-2.1h8.8a2.1 2.1 0 0 1 2.1 2.1V8" /><rect x="3.5" y="8" width="17" height="11.5" rx="2.2" /><path d="M3.5 12.6h17M10.4 12.6v2.6h3.2v-2.6" /></>,
  sets: <><path d="M12 3.6 3.6 8 12 12.4 20.4 8z" /><path d="M3.6 12 12 16.4 20.4 12M3.6 16 12 20.4 20.4 16" /></>,
  wishlist: <path d="M12 3.7l2.55 5.25 5.75.8-4.2 4.05 1 5.7L12 16.8 6.9 19.5l1-5.7-4.2-4.05 5.75-.8z" />,
  rules: <><path d="M5 4.6h13.6v14.8H7.2A2.2 2.2 0 0 1 5 17.2z" /><path d="M5 17.2a2.2 2.2 0 0 1 2.2-2.2h11.4M9 8.4h6" /></>,
  advisor: <><path d="M10.5 3.8l1.9 4.9 4.9 1.9-4.9 1.9-1.9 4.9-1.9-4.9-4.9-1.9 4.9-1.9z" /><path d="M18.2 14.6l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" /></>,
  play: <path d="M12 20.2s-7.6-4.5-7.6-10.2a4.3 4.3 0 0 1 7.6-2.7 4.3 4.3 0 0 1 7.6 2.7c0 5.7-7.6 10.2-7.6 10.2z" />,
  search: <><circle cx="10.8" cy="10.8" r="6.4" /><path d="M15.6 15.6l4.8 4.8" /></>,
  scan: <><path d="M4 8V6.2A2.2 2.2 0 0 1 6.2 4H8M16 4h1.8A2.2 2.2 0 0 1 20 6.2V8M20 16v1.8a2.2 2.2 0 0 1-2.2 2.2H16M8 20H6.2A2.2 2.2 0 0 1 4 17.8V16" /><path d="M7.5 12h9" /></>,
  sync: <><path d="M19.6 11a7.8 7.8 0 0 0-14-3.4L4.2 9.4M4.2 4.4v5h5" /><path d="M4.4 13a7.8 7.8 0 0 0 14 3.4l1.4-1.8M19.8 19.6v-5h-5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  moon: <path d="M20 14.2A8 8 0 0 1 9.8 4 8 8 0 1 0 20 14.2z" />,
  auto: <><circle cx="12" cy="12" r="8" /><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="M5 12.6l4.4 4.4L19 7.4" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  trend: <><path d="M4 16.5l5-5 4 4 7-8" /><path d="M15 7.5h5v5" /></>,
  deck: <><rect x="4" y="6" width="12" height="15" rx="2.4" /><path d="M8 3.4h9.6A2.4 2.4 0 0 1 20 5.8V17" /></>,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  info: <><circle cx="12" cy="12" r="8.4" /><path d="M12 11v5M12 7.8v.1" /></>,
  alert: <><path d="M12 4.2l9 15.6H3z" /><path d="M12 10v4.4M12 17.2v.1" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {P[name]}
    </svg>
  );
}
