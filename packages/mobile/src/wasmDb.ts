import type { Db, Statement } from '../../server/src/schema.ts';

/** The part of SQLite WASM's `oo1.Database` that we use. */
interface Oo1Stmt {
  bind(params: unknown[]): unknown;
  step(): boolean;
  get(target: object): Record<string, unknown>;
  reset(clearBindings?: boolean): unknown;
}
export interface Oo1Db {
  exec(sql: string): unknown;
  prepare(sql: string): Oo1Stmt;
  changes(): number;
  selectValue(sql: string): unknown;
}

/**
 * Make SQLite WASM look like the `Db` the shared server code expects (the same shape as node:sqlite): `prepare(sql)` gives
 * `all` / `get` / `run`, taking positional parameters. Prepared statements are cached by SQL text, because one search runs the
 * same small query for every card on the page.
 */
export function wrapDb(db: Oo1Db): Db {
  const cache = new Map<string, Oo1Stmt>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  // node:sqlite binds `undefined` as an error and null as NULL; here both are NULL, so a missing optional parameter is harmless.
  const bind = (s: Oo1Stmt, params: unknown[]) => { if (params.length) s.bind(params.map((p) => (p === undefined ? null : p))); };

  return {
    exec: (sql: string) => { db.exec(sql); },
    prepare(sql: string): Statement {
      return {
        all(...params) {
          const s = stmt(sql);
          const rows: unknown[] = [];
          try { bind(s, params); while (s.step()) rows.push(s.get({})); } finally { s.reset(true); }
          return rows;
        },
        get(...params) {
          const s = stmt(sql);
          try { bind(s, params); return s.step() ? s.get({}) : undefined; } finally { s.reset(true); }
        },
        run(...params) {
          const s = stmt(sql);
          try { bind(s, params); s.step(); } finally { s.reset(true); }
          return { changes: db.changes(), lastInsertRowid: Number(db.selectValue('SELECT last_insert_rowid()')) };
        },
      };
    },
  };
}
