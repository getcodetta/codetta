// Typed wrappers around localStorage that swallow the access errors
// (private-mode / disabled-storage / quota-exceeded) every call would
// otherwise need to catch by hand. Most modules were duplicating the
// same try { JSON.parse(getItem(K)) } catch { return fallback } pattern;
// pulling it here cuts ~6 lines per call-site and keeps fallback
// semantics consistent.
//
// The library is deliberately small — opinionated wrappers, not a
// general-purpose persistence layer. If a caller needs richer
// validation (typeof checks on individual fields), it should still
// JSON.parse via getJson<T>() and validate the shape itself.

/** Read a JSON value from localStorage, returning `fallback` on any
 *  failure (key missing, JSON parse error, storage disabled). The
 *  optional `valid` predicate doubles as a runtime type-narrowing guard
 *  so callers can opt in to shape validation without a separate cast. */
export function getJson<T>(
  key: string,
  fallback: T,
  valid?: (parsed: unknown) => parsed is T,
): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (valid && !valid(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** Serialize-and-write a value to localStorage, ignoring quota / disabled
 *  errors. Returns true on success so callers that care can branch. */
export function setJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Plain string read with safe access. Returns null when the key is
 *  missing OR when storage is unavailable. */
export function getString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Plain string write — safely no-ops when storage is unavailable. */
export function setString(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Remove a key, swallowing access errors. */
export function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
