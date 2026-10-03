import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { createRouter } from './routes.js';
import { getCardByName, getCardDetail } from './cards.js';
import { setOwned } from './collection.js';
import { createDeck, setCardQty } from './decks.js';
import { exportUserData, parseBackup, restoreUserData } from './backup.js';
import { clearWishlist, getWishlist, setWanted, wishMissing } from './wishlist.js';
import { BadRequestError } from './decks.js';
import { sfCard } from './testutil.js';

const FIXTURE = [
  sfCard({ name: 'Sol Ring', type_line: 'Artifact', prices: { usd: '2.00' } }),
  sfCard({ name: 'Cultivate', type_line: 'Sorcery', color_identity: ['G'], prices: { usd: '0.50' } }),
  sfCard({ name: 'Mystery', type_line: 'Instant' }), // no price
  sfCard({ name: 'Forest', type_line: 'Basic Land — Forest', color_identity: ['G'] }),
];
let db: Db;
const id = (name: string) => getCardByName(db, name)!.id;
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
});

describe('the wishlist', () => {
  it('is empty at first', () => {
    expect(getWishlist(db)).toEqual({ items: [], open: 0, totalUsd: 0, unpriced: 0 });
  });

  it('holds the copies you want in total, so what is still to find is that less what you own', () => {
    setWanted(db, id('Sol Ring'), 3);
    setOwned(db, id('Sol Ring'), 1);
    const w = getWishlist(db);
    expect(w.items).toHaveLength(1);
    expect(w.items[0]).toMatchObject({ want: 3, owned: 1, need: 2, costUsd: 4 });
    expect(w).toMatchObject({ open: 1, totalUsd: 4, unpriced: 0 });
  });

  it('fills itself in as you collect, keeps a met wish at the bottom, and leaves it out of the cost', () => {
    setWanted(db, id('Sol Ring'), 2);
    setWanted(db, id('Cultivate'), 1);
    setOwned(db, id('Sol Ring'), 2); // got them all
    const w = getWishlist(db);
    expect(w.items.map((i) => [i.card.name, i.need])).toEqual([['Cultivate', 1], ['Sol Ring', 0]]);
    expect(w.items[1]!.costUsd).toBeNull();
    expect(w).toMatchObject({ open: 1, totalUsd: 0.5 });
  });

  it('lists the dearest first, and counts a card with no price as unpriced', () => {
    setWanted(db, id('Cultivate'), 1);
    setWanted(db, id('Sol Ring'), 1);
    setWanted(db, id('Mystery'), 1);
    const w = getWishlist(db);
    expect(w.items.map((i) => i.card.name)).toEqual(['Sol Ring', 'Cultivate', 'Mystery']);
    expect(w).toMatchObject({ open: 3, totalUsd: 2.5, unpriced: 1 });
  });

  it('takes a card off with 0, and rejects nonsense', () => {
    setWanted(db, id('Sol Ring'), 2);
    setWanted(db, id('Sol Ring'), 0);
    expect(getWishlist(db).items).toEqual([]);
    expect(() => setWanted(db, id('Sol Ring'), -1)).toThrow(BadRequestError);
    expect(() => setWanted(db, id('Sol Ring'), 1.5)).toThrow(BadRequestError);
    expect(() => setWanted(db, id('Sol Ring'), 10000)).toThrow(BadRequestError);
    expect(() => setWanted(db, 'no-such-card', 1)).toThrow(BadRequestError);
    expect(() => setWanted(db, 'no-such-card', 0)).not.toThrow(); // removing something that is not there is fine
  });

  it('shows on the card detail', () => {
    expect(getCardDetail(db, id('Sol Ring'))!.wanted).toBe(0);
    setWanted(db, id('Sol Ring'), 4);
    expect(getCardDetail(db, id('Sol Ring'))!.wanted).toBe(4);
  });

  it('can be cleared', () => {
    setWanted(db, id('Sol Ring'), 1);
    clearWishlist(db);
    expect(getWishlist(db).items).toEqual([]);
  });
});

describe('wishing for what a deck is missing', () => {
  const deck = () => {
    const d = createDeck(db, 'Test', 'commander');
    setCardQty(db, d.id, id('Sol Ring'), 'main', 1);
    setCardQty(db, d.id, id('Cultivate'), 'main', 2);
    setCardQty(db, d.id, id('Forest'), 'main', 30);
    return d.id;
  };

  it('wants enough copies to finish the deck, and ignores basic lands and cards you have', () => {
    setOwned(db, id('Sol Ring'), 1);
    setOwned(db, id('Cultivate'), 1);
    expect(wishMissing(db, deck())).toEqual({ added: 1 });
    const w = getWishlist(db);
    expect(w.items.map((i) => [i.card.name, i.want, i.need])).toEqual([['Cultivate', 2, 1]]);
  });

  it('never lowers a wish you already made, and says how many it added', () => {
    setWanted(db, id('Cultivate'), 5);
    const d = deck();
    expect(wishMissing(db, d)).toEqual({ added: 1 }); // only Sol Ring: Cultivate is already wanted by more than this deck needs
    expect(getWishlist(db).items.find((i) => i.card.name === 'Cultivate')!.want).toBe(5);
    expect(wishMissing(db, d)).toEqual({ added: 0 }); // nothing new the second time
  });

  it('counts copies in other decks as taken when asked, wanting the extra ones', () => {
    setOwned(db, id('Sol Ring'), 1);
    const a = createDeck(db, 'A', 'commander'); setCardQty(db, a.id, id('Sol Ring'), 'main', 1);
    const b = createDeck(db, 'B', 'commander'); setCardQty(db, b.id, id('Sol Ring'), 'main', 1);
    expect(wishMissing(db, b.id, { excludeOtherDecks: true })).toEqual({ added: 1 });
    expect(getWishlist(db).items[0]).toMatchObject({ want: 2, need: 1 }); // you own 1, deck A uses it, so you want a second for deck B
    expect(wishMissing(db, a.id)).toEqual({ added: 0 }); // counted loosely, deck A is already covered by the copy you own
  });
});

describe('the routes', () => {
  const call = () => createRouter({ db, data: {} as never, semantic: {} as never });
  it('list, set, and clear', async () => {
    const r = call();
    expect((await r({ method: 'PUT', path: '/api/wishlist', body: { cardId: id('Sol Ring'), want: 2 } })).body).toMatchObject({ open: 1 });
    expect((await r({ method: 'GET', path: '/api/wishlist' })).body).toMatchObject({ items: [{ want: 2 }] });
    expect((await r({ method: 'PUT', path: '/api/wishlist', body: { cardId: id('Sol Ring'), want: -3 } })).status).toBe(400);
    expect((await r({ method: 'DELETE', path: '/api/wishlist' })).status).toBe(204);
    expect((await r({ method: 'GET', path: '/api/wishlist' })).body).toMatchObject({ items: [] });
  });

  it('wish for a deck\'s missing cards', async () => {
    const r = call();
    const d = createDeck(db, 'Test', 'commander'); setCardQty(db, d.id, id('Cultivate'), 'main', 2);
    expect((await r({ method: 'POST', path: `/api/decks/${d.id}/wishlist-missing`, body: {} })).body).toEqual({ added: 1 });
    expect(getWishlist(db).items[0]).toMatchObject({ want: 2 });
  });
});

describe('backup', () => {
  it('carries the wishlist, and an older backup without one still restores', async () => {
    setWanted(db, id('Sol Ring'), 3);
    const backup = exportUserData(db);
    expect(backup.wishlist).toEqual([{ id: id('Sol Ring'), name: 'Sol Ring', want: 3 }]);

    clearWishlist(db);
    expect(restoreUserData(db, backup, 'merge')).toMatchObject({ wishlist: 1 });
    expect(getWishlist(db).items[0]).toMatchObject({ want: 3 });

    const { wishlist: _gone, ...older } = backup;
    setWanted(db, id('Cultivate'), 1);
    expect(restoreUserData(db, older, 'merge')).toMatchObject({ wishlist: 0 });
    expect(getWishlist(db).items).toHaveLength(2); // merging an old backup leaves the wishlist as it was
    restoreUserData(db, older, 'replace');
    expect(getWishlist(db).items).toEqual([]); // replacing wipes it, as it does decks and the collection
  });

  it('merging never makes a wish smaller, and replacing swaps the list', () => {
    setWanted(db, id('Sol Ring'), 2);
    const backup = exportUserData(db);
    setWanted(db, id('Sol Ring'), 5);
    restoreUserData(db, backup, 'merge');
    expect(getWishlist(db).items[0]!.want).toBe(5);
    restoreUserData(db, backup, 'replace');
    expect(getWishlist(db).items[0]!.want).toBe(2);
  });

  it('is checked on the way in', () => {
    const ok = exportUserData(db);
    expect(() => parseBackup({ ...ok, wishlist: 'nope' })).toThrow(BadRequestError);
    expect(() => parseBackup({ ...ok, wishlist: [{ id: 'x', name: 'x', want: 0 }] })).toThrow(BadRequestError);
  });
});
