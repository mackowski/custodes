import { Policy } from '@custodes/schema';
import raw from '../policy/policy.json';

/** Parsed once per isolate. A malformed policy fails the Worker fast, which is what we want. */
export const policy: Policy = Policy.parse(raw);
