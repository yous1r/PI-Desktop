import { MemoryError } from '../contracts.js';
import { sanitize } from '../capture/policy.js';
/** A legacy hook performed an unexpected claim. Preserve its response for explicit recovery. */
export class UnexpectedHandoffError extends MemoryError {
  readonly recovery: unknown;
  constructor(result: unknown) {
    super('SESSION_START_CONSUMED_HANDOFF');
    this.recovery = sanitize(result, 16000);
  }
}
