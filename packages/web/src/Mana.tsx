import { Fragment, useState } from 'react';

// Mana symbols. The pictures are Scryfall's symbol set, hotlinked like card images; when they can't load (offline, blocked) each symbol
// stays as a coloured disc with its letters, so a cost is always readable.
const SYMBOL_URL = (code: string) => `https://svgs.scryfall.io/card-symbols/${code}.svg`;
const COLOURS = new Set(['W', 'U', 'B', 'R', 'G', 'C']);

/** "{2}{G/U}" -> ["2", "G/U"]. */
export const manaSymbols = (cost: string): string[] => [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
/** A symbol's file name at Scryfall: {G/U} is GU, {T} is T. */
const fileFor = (symbol: string) => symbol.replace(/\//g, '');
const tone = (symbol: string) => symbol.split('/').find((p) => COLOURS.has(p)) ?? 'N';

function Symbol({ symbol, labelled = false }: { symbol: string; labelled?: boolean }) {
  const [failed, setFailed] = useState(false);
  // Inside a whole cost the cost carries the label; a symbol standing in running text carries its own.
  return (
    <span className={`mana mana-${tone(symbol)}`} {...(labelled ? { role: 'img', 'aria-label': `{${symbol}}` } : { 'aria-hidden': true })}>
      <span className="mana-text">{symbol.replace(/\//g, '')}</span>
      {!failed && <img src={SYMBOL_URL(fileFor(symbol))} alt="" loading="lazy" onError={() => setFailed(true)} />}
    </span>
  );
}

/** A mana cost as symbols. Screen readers get the plain cost ("{2}{G}"). */
export function ManaCost({ cost }: { cost: string }) {
  const symbols = manaSymbols(cost);
  if (symbols.length === 0) return null;
  return <span className="manacost" role="img" aria-label={`Mana cost ${cost}`}>{symbols.map((s, i) => <Symbol key={i} symbol={s} />)}</span>;
}

/** Card text with its {T}, {2}, {G} turned into symbols (each still carries its own text for screen readers). */
export function ManaText({ text }: { text: string }) {
  return <>{text.split(/(\{[^}]+\})/g).map((part, i) => (/^\{[^}]+\}$/.test(part) ? <Symbol key={i} symbol={part.slice(1, -1)} labelled /> : <Fragment key={i}>{part}</Fragment>))}</>;
}
