import { useEffect, useState } from 'react';
import { RulesView } from './RulesView';
import { BanlistView } from './BanlistView';

/** The Rules tab: the Comprehensive Rules, and the banlists. */
export function RulesHome({ openRule, onRuleOpened, onOpenCard }: { openRule: string | null; onRuleOpened: () => void; onOpenCard: (id: string) => void }) {
  const [part, setPart] = useState<'rules' | 'banlists'>('rules');
  useEffect(() => { if (openRule) setPart('rules'); }, [openRule]); // a rule asked for from a card's keywords
  return (
    <>
      <span className="seg" role="group" aria-label="Rules or banlists">
        <button className={part === 'rules' ? 'active' : ''} aria-pressed={part === 'rules'} onClick={() => setPart('rules')}>Comprehensive Rules</button>
        <button className={part === 'banlists' ? 'active' : ''} aria-pressed={part === 'banlists'} onClick={() => setPart('banlists')}>Banlists</button>
      </span>
      {part === 'rules' ? <RulesView openRule={openRule} onRuleOpened={onRuleOpened} /> : <BanlistView onOpenCard={onOpenCard} />}
    </>
  );
}
