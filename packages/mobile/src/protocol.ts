import type { ApiRequest, ApiResponse } from '../../server/src/routes.ts';

/** What the worker asks the page to do on its behalf: the page has the native plugins, the worker doesn't. */
export type NativeRequest =
  /** Download a (big) file to the app's cache without the browser's CORS rules. Resolves with a URL the worker can read it from. */
  | { op: 'download'; url: string; name: string }
  /** Download a small text file and return its contents. */
  | { op: 'text'; url: string; name: string }
  /** Delete a file from the cache. */
  | { op: 'delete'; name: string }
  /** A small secret in the Android Keystore (the advisor's API key). */
  | { op: 'secret-get'; name: string }
  | { op: 'secret-set'; name: string; value: string }
  | { op: 'secret-clear'; name: string };

export type NativeResult = { ok: true; url?: string; text?: string } | { ok: false; error: string; status?: number };

/** Messages between the page (bridge) and the worker that runs the app's API. */
export type ToWorker =
  | { id: number; req: ApiRequest }
  | { init: { dbUrl: string; /** the page is inside the native app (downloads go through the Filesystem plugin) */ native: boolean; /** where card data updates are published (a test can point it elsewhere) */ dataBase?: string; /** mobile data or a data saver is on */ metered?: boolean; /** where the ready-made semantic index and the language model are published (tests only) */ semanticBase?: string; modelBase?: string; /** where the advisor sends its requests (tests only) */ advisorBase?: string } }
  | { nativeResult: { id: number; result: NativeResult } }
  | { nativeProgress: { id: number; received: number; total: number } };

export type FromWorker =
  | { ready: true; cards: number }
  | { fatal: string }
  | { progress: string }
  | { reload: true }
  | { native: { id: number; request: NativeRequest } }
  | { id: number; res: ApiResponse }
  | { id: number; error: string };
