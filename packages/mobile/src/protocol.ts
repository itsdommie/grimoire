import type { ApiRequest, ApiResponse } from '../../server/src/routes.ts';

/** Messages between the page (bridge) and the worker that runs the app's API. */
export type ToWorker = { id: number; req: ApiRequest } | { init: { dbUrl: string } };
export type FromWorker =
  | { ready: true; cards: number }
  | { fatal: string }
  | { progress: string }
  | { id: number; res: ApiResponse }
  | { id: number; error: string };
