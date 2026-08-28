import type { Vendor, VendorId } from './types';

/* ------------------------------------------------------------------ *
 * The vendor registry.
 *
 * One place that knows which vendors exist, so a picker, a lookup and a
 * saved preference cannot disagree about the set.
 * ------------------------------------------------------------------ */

/**
 * Generic is not a vendor and has no data file: it is the ABSENCE of one,
 * which is why it carries no kinds. Listed here so the picker has something
 * to show for the default and so "switch back" is a real choice rather than
 * a special case.
 */
const GENERIC: Vendor = {
  id: 'generic',
  label: 'Generic',
  kinds: {},
};

export const VENDORS: ReadonlyArray<{ id: VendorId; label: string }> = [
  { id: 'generic', label: 'Generic' },
  { id: 'aws', label: 'AWS' },
  { id: 'gcp', label: 'Google' },
  { id: 'azure', label: 'Azure' },
];

export { GENERIC };
export type { Vendor, VendorId } from './types';
