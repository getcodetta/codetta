import type { ProviderId } from "./types";
import { getString, remove, setString } from "../localStore";

const STORAGE_PREFIX = "lcp.providers.";
const keyFor = (id: ProviderId) => `${STORAGE_PREFIX}${id}.apiKey`;

export function getApiKey(providerId: ProviderId): string {
  return getString(keyFor(providerId)) ?? "";
}

export function setApiKey(providerId: ProviderId, key: string): void {
  if (key) setString(keyFor(providerId), key);
  else remove(keyFor(providerId));
}

export function hasApiKey(providerId: ProviderId): boolean {
  return getApiKey(providerId).length > 0;
}
