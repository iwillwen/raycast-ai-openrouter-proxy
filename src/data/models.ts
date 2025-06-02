import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { z } from 'zod/v4';

export const ModelConfig = z.object({
  name: z.string(),
  id: z.string(),
  contextLength: z.number(),
  capabilities: z.array(z.enum(['vision', 'tools'])),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  max_tokens: z.int().min(1).optional(),
  extra: z.record(z.string(), z.any()).optional(),
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

export const generateModelsList = (models: ModelConfig[]) => {
  return {
    models: models.map((config) => ({
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

export const generateModelInfo = (models: ModelConfig[], modelName: string) => {
  const config = findModelConfig(models, modelName);

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
