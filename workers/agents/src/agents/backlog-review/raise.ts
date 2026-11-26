import type { BacklogVerdict } from '@custodes/schema';

/**
 * Code raises a verdict to a human (#132 update 2): anything short of high confidence, any reason
 * for doubt, or a state no rule covers. The model can raise too; nothing here lowers.
 */
export function raisesToHuman(v: BacklogVerdict): boolean {
  return v.confidence !== 'high' || v.uncertainBecause.length > 0 || v.state === 'unknown';
}
