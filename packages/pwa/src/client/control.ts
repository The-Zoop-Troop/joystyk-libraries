// The page reads the flag file (../control.ts) straight from the network: the worker never
// caches it, and the request skips the HTTP cache too.
import { parseControl, type Control } from '../control.ts';
import { CONTROL_URL } from '../names.ts';

/** Reads the flag file. A failure (offline, a bad file) reads as no instruction. */
export const readControl = async (): Promise<Control | null> => {
  try {
    const response = await fetch(CONTROL_URL, { cache: 'no-store', credentials: 'omit' });
    return response.ok ? parseControl(await response.json()) : null;
  } catch {
    return null;
  }
};
