// rev-a2b81d-20260901 HermesModelConfig.ts
import { ModelConfig, ModelProvider } from '../../schema/HermesTypes';

export type HermesModelId =
  | 'hermes3:7b'
  | 'hermes3:13b'
  | 'hermes3:70b'
  | 'hermes4:8b'
  | 'hermes4:34b'
  | 'hermes-3-llama-3.1-8b'
  | 'hermes-3-llama-3.1-70b'
  | 'hermes-3-mistral-7b'
  | 'nous-hermes-2-mistral-7b-dpo';

export interface HermesModelMeta {
  id: HermesModelId | string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  parameterCount: string;
  generation: 3 | 4;
  ollamaTag: string;
  supportsTools: boolean;
  supportsVision: boolean;
  quantizations: string[];
  vramRequiredGB: number;
  description: string;
}

/**
 * HermesModelConfig — catalogue of Nous Research Hermes model configurations.
 * Provides default ModelConfig objects for each Hermes model variant.
 */
export class HermesModelConfig {
  private static readonly MODELS: Record<string, HermesModelMeta> = {
    'hermes3:7b': {
      id: 'hermes3:7b',
      displayName: 'Hermes 3 (7B)',
      contextWindow: 8192,
      maxOutputTokens: 4096,
      parameterCount: '7B',
      generation: 3,
      ollamaTag: 'hermes3:7b',
      supportsTools: true,
      supportsVision: false,
      quantizations: ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'F16'],
      vramRequiredGB: 6,
      description:
        'Nous Research Hermes 3 7B — fast, capable agent model for tool use and reasoning. ' +
        'Best for everyday tasks on consumer hardware.',
    },
    'hermes3:13b': {
      id: 'hermes3:13b',
      displayName: 'Hermes 3 (13B)',
      contextWindow: 8192,
      maxOutputTokens: 4096,
      parameterCount: '13B',
      generation: 3,
      ollamaTag: 'hermes3:13b',
      supportsTools: true,
      supportsVision: false,
      quantizations: ['Q4_K_M', 'Q5_K_M', 'Q8_0'],
      vramRequiredGB: 10,
      description:
        'Hermes 3 13B — stronger reasoning and better instruction following than 7B. ' +
        'Recommended for complex multi-step agent tasks.',
    },
    'hermes3:70b': {
      id: 'hermes3:70b',
      displayName: 'Hermes 3 (70B)',
      contextWindow: 8192,
      maxOutputTokens: 4096,
      parameterCount: '70B',
      generation: 3,
      ollamaTag: 'hermes3:70b',
      supportsTools: true,
      supportsVision: false,
      quantizations: ['Q4_K_M', 'Q5_K_M'],
      vramRequiredGB: 40,
      description:
        'Hermes 3 70B — largest Hermes 3 variant. Near GPT-4 quality for agentic tasks. ' +
        'Requires high-end GPU or multi-GPU setup.',
    },
    'hermes4:8b': {
      id: 'hermes4:8b',
      displayName: 'Hermes 4 (8B)',
      contextWindow: 131072,
      maxOutputTokens: 8192,
      parameterCount: '8B',
      generation: 4,
      ollamaTag: 'hermes4:8b',
      supportsTools: true,
      supportsVision: false,
      quantizations: ['Q4_K_M', 'Q5_K_M', 'Q8_0', 'F16'],
      vramRequiredGB: 6,
      description:
        'Nous Research Hermes 4 8B — latest generation Hermes with 128K context window. ' +
        'Significantly improved tool use and agentic reasoning over Hermes 3.',
    },
    'hermes4:34b': {
      id: 'hermes4:34b',
      displayName: 'Hermes 4 (34B)',
      contextWindow: 131072,
      maxOutputTokens: 8192,
      parameterCount: '34B',
      generation: 4,
      ollamaTag: 'hermes4:34b',
      supportsTools: true,
      supportsVision: false,
      quantizations: ['Q4_K_M', 'Q5_K_M'],
      vramRequiredGB: 20,
      description:
        'Hermes 4 34B — flagship Nous Research model for complex autonomous agent workflows. ' +
        '128K context, advanced multi-step reasoning, excellent code generation.',
    },
  };

  /** Get metadata for a specific Hermes model. */
  static get(modelId: string): HermesModelMeta | undefined {
    return this.MODELS[modelId];
  }

  /** Get all known Hermes models. */
  static all(): HermesModelMeta[] {
    return Object.values(this.MODELS);
  }

  /** Get models for a specific Hermes generation (3 or 4). */
  static byGeneration(gen: 3 | 4): HermesModelMeta[] {
    return Object.values(this.MODELS).filter((m) => m.generation === gen);
  }

  /** Return a default ModelConfig for the given Hermes model ID. */
  static defaultConfig(modelId: string, provider: ModelProvider = 'ollama'): ModelConfig {
    const meta = this.MODELS[modelId];
    if (!meta) {
      // Generic fallback for unknown/custom model IDs
      return {
        provider,
        model: modelId,
        baseUrl: 'http://localhost:11434',
        temperature: 0.7,
        maxTokens: 4096,
        contextWindow: 8192,
        topP: 0.9,
      };
    }

    return {
      provider,
      model: meta.ollamaTag,
      baseUrl: provider === 'ollama' ? 'http://localhost:11434' : undefined,
      temperature: 0.7,
      maxTokens: meta.maxOutputTokens,
      contextWindow: meta.contextWindow,
      topP: 0.9,
    };
  }

  /**
   * Recommended fallback chain for local inference:
   * Try the best available model first, fall back to lighter ones.
   */
  static fallbackChain(): string[] {
    return ['hermes4:34b', 'hermes4:8b', 'hermes3:70b', 'hermes3:13b', 'hermes3:7b'];
  }

  /** Return models that fit within the given VRAM budget. */
  static fitsInVram(vramGB: number): HermesModelMeta[] {
    return Object.values(this.MODELS)
      .filter((m) => m.vramRequiredGB <= vramGB)
      .sort((a, b) => b.vramRequiredGB - a.vramRequiredGB);
  }
}
