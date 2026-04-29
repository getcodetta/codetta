import type { ProviderId } from "./types";

const STORAGE_PREFIX = "lcp.providers.";

export function getApiKey(providerId: ProviderId): string {
  try {
    return localStorage.getItem(STORAGE_PREFIX + providerId + ".apiKey") ?? "";
  } catch {
    return "";
  }
}

export function setApiKey(providerId: ProviderId, key: string): void {
  try {
    if (key) {
      localStorage.setItem(STORAGE_PREFIX + providerId + ".apiKey", key);
    } else {
      localStorage.removeItem(STORAGE_PREFIX + providerId + ".apiKey");
    }
  } catch {
    /* ignore */
  }
}

export function hasApiKey(providerId: ProviderId): boolean {
  return getApiKey(providerId).length > 0;
}
