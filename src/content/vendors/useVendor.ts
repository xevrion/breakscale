import { useEffect, useState } from 'react';
import { usePreference } from '../preferences';
import { loadVendor, peekVendor } from './lookup';
import type { Vendor } from './types';

/**
 * The vendor currently chosen, once its data has arrived.
 *
 * Null while generic is selected, and null for the first render after a
 * switch: the vendor files are loaded on demand so that a reader who never
 * leaves generic never downloads three catalogues of instance specs. Every
 * consumer already falls back to the plain name, so that gap shows the
 * right thing rather than a blank.
 */
export function useVendor(): Vendor | null {
  const id = usePreference('vendor');
  const [vendor, setVendor] = useState<Vendor | null>(() => peekVendor(id));

  useEffect(() => {
    if (id === 'generic') {
      setVendor(null);
      return;
    }
    // Synchronous when the file is already cached, so switching back to a
    // vendor you have used does not flash the generic names.
    const cached = peekVendor(id);
    if (cached) {
      setVendor(cached);
      return;
    }
    let live = true;
    void loadVendor(id).then((v) => {
      if (live) setVendor(v);
    });
    return () => {
      live = false;
    };
  }, [id]);

  return vendor;
}
