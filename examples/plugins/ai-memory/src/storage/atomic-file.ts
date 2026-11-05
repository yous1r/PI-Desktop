import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryError } from '../contracts.js';

/** Keep the canonical file intact while Windows readers/indexers release transient locks. */
export async function replaceSnapshot(
  temporary: string,
  canonical: string,
  move: typeof rename = rename,
  wait: (milliseconds: number) => Promise<unknown> = delay,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await move(temporary, canonical); return; }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(String(code))) throw new MemoryError('STATE_UNWRITABLE');
      await wait(25 * 2 ** attempt);
    }
  }
}
