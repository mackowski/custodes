const METADATA_KEY = /^[A-Za-z]{1,30}$/;
const METADATA_VALUE = /^[A-Za-z0-9_.:/#-]{1,100}$/;

/**
 * AI Gateway logs keep metadata outside the `TRACE_PAYLOADS` switch, and allow at most 5 entries:
 * refuse anything but a few id-like values, so no untrusted text can end up there. Every client
 * that sends `cf-aig-metadata` calls this before any request.
 */
export function gatewayMetadata(m: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(m);
  if (
    entries.length > 5 ||
    !entries.every(([k, v]) => METADATA_KEY.test(k) && METADATA_VALUE.test(v))
  )
    throw new Error('gateway metadata must be at most 5 id-like entries');
  return Object.fromEntries(entries);
}
