import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { z } from 'zod/v4';
import OpenAI from 'openai';

export const ModelConfig = z.object({
  name: z.string(),
  id: z.string(),
  contextLength: z.number(),
  capabilities: z.array(z.enum(['vision', 'tools', 'thinking'])),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  max_tokens: z.int().min(1).optional(),
  extra: z.record(z.string(), z.any()).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export function loadModels(): ModelConfig[] {
  const filePath = path.resolve(__dirname, '../../models.json');
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const models = JSON.parse(fileContent);
  return z.array(ModelConfig).parse(models);
}

export const findModelConfig = (
  models: ModelConfig[],
  modelName: string,
): ModelConfig | undefined => {
  return models.find((config) => config.name === modelName);
};

function generateDigest(modelName: string): string {
  return crypto.createHash('sha256').update(modelName).digest('hex');
}

/**
 * 获取本地 Ollama 服务的模型列表
 */
export const fetchLocalOllamaModels = async (): Promise<ModelConfig[]> => {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (!response.ok) {
      console.warn('Failed to fetch local Ollama models:', response.statusText);
      return [];
    }

    interface OllamaModel {
      name: string;
      model?: string;
      modified_at?: string;
      size?: number;
      digest?: string;
    }

    interface OllamaResponse {
      models?: OllamaModel[];
    }

    const data = (await response.json()) as OllamaResponse;
    const localModels: ModelConfig[] =
      data.models?.map((model: OllamaModel) => ({
        name: `${model.name} [Local]`,
        id: model.name,
        contextLength: 4096, // Default context length for local models
        capabilities: ['tools'], // Default capabilities
        temperature: 0.7,
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'ollama', // Dummy API key for local Ollama
      })) || [];

    return localModels;
  } catch (error) {
    console.warn('Error fetching local Ollama models:', error);
    return [];
  }
};

export const generateModelsList = async (models: ModelConfig[]) => {
  // 获取本地 Ollama 模型
  const localModels = await fetchLocalOllamaModels();

  // 合并配置文件中的模型和本地 Ollama 模型
  const allModels = [...models, ...localModels];

  return {
    models: allModels.map((config) => ({
      name: config.name,
      model: config.id,
      modified_at: new Date().toISOString(),
      size: 500000000, // Fixed size
      digest: generateDigest(config.id),
      details: {
        parent_model: '',
        format: 'gguf',
        family: 'llama',
        families: ['llama'],
        parameter_size: '7B',
        quantization_level: 'Q4_K_M',
      },
    })),
  };
};

export const generateModelInfo = async (models: ModelConfig[], modelName: string) => {
  // 获取本地 Ollama 模型
  const localModels = await fetchLocalOllamaModels();

  // 合并配置文件中的模型和本地 Ollama 模型
  const allModels = [...models, ...localModels];

  const config = findModelConfig(allModels, modelName);

  if (!config) {
    throw new Error(`Model ${modelName} not found`);
  }

  return {
    modelfile: `FROM ${config.name}`,
    parameters: 'stop "<|eot_id|>"',
    template: '{{ .Prompt }}',
    details: {
      parent_model: '',
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '7B',
      quantization_level: 'Q4_K_M',
    },
    model_info: {
      'general.architecture': 'llama',
      'general.file_type': 2,
      'general.parameter_count': 7000000000,
      'llama.context_length': config.contextLength,
      'llama.embedding_length': 4096,
      'tokenizer.ggml.model': 'gpt2',
    },
    capabilities: ['completion', ...config.capabilities],
  };
};

/**
 * 为指定的模型配置创建 OpenAI 实例
 * 如果模型配置中包含 baseUrl 和 apiKey，则使用这些配置创建独立的实例
 * 否则返回 null，表示应该使用默认的 OpenAI 实例
 */
export const createOpenAIInstanceForModel = (config: ModelConfig): OpenAI | null => {
  if (config.baseUrl && config.apiKey) {
    return new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    });
  }
  return null;
};

/**
 * 获取用于指定模型的 OpenAI 实例
 * 优先使用模型特定的配置，如果没有则使用默认实例
 */
export const getOpenAIInstanceForModel = (config: ModelConfig, defaultOpenAI: OpenAI): OpenAI => {
  const modelSpecificInstance = createOpenAIInstanceForModel(config);
  return modelSpecificInstance || defaultOpenAI;
};
