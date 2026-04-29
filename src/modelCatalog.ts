// Curated Ollama model catalog. The list is hand-picked and labelled so the
// user can pick a model without having to remember exact tags.

export interface CatalogModel {
  /** Ollama model tag, e.g. "qwen2.5-coder:7b" */
  name: string;
  category: "coding" | "general" | "reasoning" | "small";
  /** Approximate disk size in GB. */
  sizeGb: number;
  /** One-liner that describes when to pick this model. */
  description: string;
  /** Approximate VRAM/RAM needed to run comfortably (GB). */
  needsRamGb?: number;
  /** Marks the recommended pick within its category. */
  recommended?: boolean;
  /** True when the model supports Ollama's native function-calling. */
  toolCalls?: boolean;
}

export const MODEL_CATALOG: CatalogModel[] = [
  // ── Coding ────────────────────────────────────────────────
  {
    name: "qwen2.5-coder:32b",
    category: "coding",
    sizeGb: 19,
    needsRamGb: 32,
    description:
      "Top local coding model — best tool-calling, edits, and reasoning. Needs a serious GPU.",
    recommended: true,
    toolCalls: true,
  },
  {
    name: "qwen2.5-coder:14b",
    category: "coding",
    sizeGb: 9,
    needsRamGb: 16,
    description: "Larger coding model — better reasoning than 7B, faster than 32B.",
    toolCalls: true,
  },
  {
    name: "qwen2.5-coder:7b",
    category: "coding",
    sizeGb: 4.7,
    needsRamGb: 8,
    description: "Solid 7B coding model — runs on most machines.",
    toolCalls: true,
  },
  {
    name: "qwen2.5-coder:3b",
    category: "coding",
    sizeGb: 1.9,
    needsRamGb: 4,
    description: "Smaller coding model — fast on modest hardware.",
    toolCalls: true,
  },
  {
    name: "deepseek-coder-v2:16b",
    category: "coding",
    sizeGb: 8.9,
    needsRamGb: 16,
    description: "DeepSeek's MoE coding model — very strong on Python/JS.",
    toolCalls: true,
  },
  {
    name: "codellama:13b",
    category: "coding",
    sizeGb: 7.4,
    needsRamGb: 12,
    description: "Meta's CodeLlama — solid all-rounder for code.",
  },
  {
    name: "codestral:22b",
    category: "coding",
    sizeGb: 12.9,
    needsRamGb: 24,
    description: "Mistral's specialised coding model — strong autocomplete.",
  },

  // ── Reasoning ─────────────────────────────────────────────
  {
    name: "deepseek-r1:7b",
    category: "reasoning",
    sizeGb: 4.7,
    needsRamGb: 8,
    description: "Reasoning model — emits <think> blocks before answering.",
    recommended: true,
  },
  {
    name: "deepseek-r1:14b",
    category: "reasoning",
    sizeGb: 9,
    needsRamGb: 16,
    description: "Larger DeepSeek-R1 — better reasoning depth.",
  },
  {
    name: "deepseek-r1:32b",
    category: "reasoning",
    sizeGb: 19,
    needsRamGb: 32,
    description: "Big DeepSeek-R1 — close to commercial reasoning models.",
  },
  {
    name: "qwq:32b",
    category: "reasoning",
    sizeGb: 19,
    needsRamGb: 32,
    description: "Qwen's QwQ reasoning model — strong math + chain-of-thought.",
  },

  // ── General ───────────────────────────────────────────────
  {
    name: "llama3.1:8b",
    category: "general",
    sizeGb: 4.7,
    needsRamGb: 8,
    description: "Meta's general-purpose 8B — solid baseline.",
    recommended: true,
    toolCalls: true,
  },
  {
    name: "llama3.3:70b",
    category: "general",
    sizeGb: 40,
    needsRamGb: 64,
    description: "Largest Llama — frontier-class output, needs a beefy box.",
    toolCalls: true,
  },
  {
    name: "qwen2.5:7b",
    category: "general",
    sizeGb: 4.7,
    needsRamGb: 8,
    description: "Qwen 2.5 — great instruction following, tool calls.",
    toolCalls: true,
  },
  {
    name: "qwen2.5:14b",
    category: "general",
    sizeGb: 9,
    needsRamGb: 16,
    description: "Bigger Qwen — better reasoning + writing.",
    toolCalls: true,
  },
  {
    name: "mistral-nemo:12b",
    category: "general",
    sizeGb: 7.1,
    needsRamGb: 12,
    description: "Mistral NeMo — multilingual, strong general use.",
    toolCalls: true,
  },
  {
    name: "mistral:7b",
    category: "general",
    sizeGb: 4.1,
    needsRamGb: 8,
    description: "Original Mistral — fast, decent for most tasks.",
    toolCalls: true,
  },

  // ── Small / fast ──────────────────────────────────────────
  {
    name: "llama3.2:3b",
    category: "small",
    sizeGb: 2,
    needsRamGb: 4,
    description: "Tiny Llama — fast on laptops, OK for chat.",
    recommended: true,
    toolCalls: true,
  },
  {
    name: "llama3.2:1b",
    category: "small",
    sizeGb: 1.3,
    needsRamGb: 2,
    description: "Sub-second responses, basic chat only.",
    toolCalls: true,
  },
  {
    name: "phi3:mini",
    category: "small",
    sizeGb: 2.4,
    needsRamGb: 4,
    description: "Microsoft Phi-3 mini — punches above its weight.",
  },
  {
    name: "phi3.5:3.8b",
    category: "small",
    sizeGb: 2.2,
    needsRamGb: 4,
    description: "Phi-3.5 — improved over phi3 mini.",
  },
  {
    name: "gemma2:2b",
    category: "small",
    sizeGb: 1.6,
    needsRamGb: 4,
    description: "Google Gemma 2 — efficient small model.",
  },
];

export const CATEGORY_LABELS: Record<CatalogModel["category"], string> = {
  coding: "Code-specialised",
  reasoning: "Reasoning",
  general: "General purpose",
  small: "Small / fast",
};
