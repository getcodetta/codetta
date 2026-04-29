import type { ChatMessage, ChatStreamEvent, ToolDef } from "../ai";

export interface ProviderModel {
  providerId: ProviderId;
  modelId: string;
  /** Human-readable label (may equal modelId). */
  displayName: string;
  /** Approximate context window in tokens, when known. */
  contextWindow?: number;
  /** Whether the model supports native tool calling. */
  supportsTools?: boolean;
}

export type ProviderId = "ollama" | "openai" | "anthropic" | "claude-code";

export interface ChatProvider {
  id: ProviderId;
  displayName: string;
  /** Provider needs an API key to function. */
  needsApiKey: boolean;
  /** Help URL shown to the user when they need to obtain a key. */
  keyHelpUrl?: string;
  /** Quick check whether the provider is reachable / configured. */
  isAvailable(): Promise<boolean>;
  /** List available models for this provider. */
  listModels(): Promise<ProviderModel[]>;
  /**
   * Stream a chat completion. The implementation must yield content text
   * incrementally and emit any tool_calls as they arrive.
   */
  chat(args: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    signal?: AbortSignal;
  }): AsyncGenerator<ChatStreamEvent, void, unknown>;
}

/** Parse a provider-qualified model id of the form "<providerId>:<modelId>". */
export function parseQualifiedModel(
  qualified: string,
): { providerId: ProviderId; modelId: string } | null {
  const i = qualified.indexOf(":");
  if (i <= 0) return null;
  const providerId = qualified.slice(0, i);
  if (
    providerId !== "ollama" &&
    providerId !== "openai" &&
    providerId !== "anthropic" &&
    providerId !== "claude-code"
  ) {
    return null;
  }
  return { providerId, modelId: qualified.slice(i + 1) };
}

export function makeQualifiedModel(
  providerId: ProviderId,
  modelId: string,
): string {
  return `${providerId}:${modelId}`;
}
