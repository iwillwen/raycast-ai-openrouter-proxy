import { NextFunction, Request, Response } from 'express';
import { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources';
import { match, P } from 'ts-pattern';
import { z } from 'zod/v4';
import { AppContext } from '../app';
import {
  fetchLocalOllamaModels,
  findModelConfig,
  generateModelInfo,
  generateModelsList,
  getOpenAIInstanceForModel,
} from '../data/models';
import { HttpError } from '../errors';
import {
  convertOllamaMessagesToOpenAI,
  convertRaycastToolsToOpenAI,
  makeOllamaChunk,
  makeSSEMessage,
  OllamaChatRequest,
  OllamaChunkResponse,
} from '../util';

export interface ApiController {
  getTags(req: Request, res: Response, next: NextFunction): void;
  getModelInfo(req: Request, res: Response, next: NextFunction): void;
  chatCompletion(req: Request, res: Response, next: NextFunction): Promise<void>;
}

export const makeApiController = ({ openai, models }: AppContext): ApiController => {
  return {
    getTags: async (req, res) => {
      const modelsList = await generateModelsList(models);
      res.send(modelsList);
    },

    getModelInfo: async (req, res) => {
      const { model } = z.object({ model: z.string() }).parse(req.body);
      const modelInfo = await generateModelInfo(models, model);
      res.send(modelInfo);
    },

    chatCompletion: async (req, res) => {
      const { messages, model: requestedModel, tools } = OllamaChatRequest.parse(req.body);

      // 获取本地 Ollama 模型
      const localModels = await fetchLocalOllamaModels();

      // 合并配置文件中的模型和本地 Ollama 模型
      const allModels = [...models, ...localModels];

      const modelConfig = findModelConfig(allModels, requestedModel);

      if (!modelConfig) {
        throw new HttpError(400, `Model ${requestedModel} not found`);
      }

      // 获取用于此模型的 OpenAI 实例（可能是模型特定的实例或默认实例）
      const modelOpenAI = getOpenAIInstanceForModel(modelConfig, openai);

      const openaiMessages = convertOllamaMessagesToOpenAI(messages);
      const openaiTools = convertRaycastToolsToOpenAI(tools);

      const chatConfig: ChatCompletionCreateParamsStreaming = {
        ...modelConfig.extra,
        model: modelConfig.id,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: modelConfig.temperature,
        top_p: modelConfig.topP,
        max_completion_tokens: modelConfig.max_tokens,
        ...(openaiTools && { tools: openaiTools }),
      };

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { messages: _, ...configWithoutMessages } = chatConfig;
      req.log.info({ configWithoutMessages }, 'ChatCompletionRequest');

      let pingInterval: NodeJS.Timeout | undefined = undefined;
      const abortController = new AbortController();

      const cleanup = () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
        clearInterval(pingInterval);
        req.log.info('ConnectionCleanup');
      };

      try {
        const stream = await modelOpenAI.chat.completions.create(chatConfig, {
          signal: abortController.signal,
        });

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        pingInterval = setInterval(() => {
          res.write('\n');
          req.log.info('ConnectionPing');
        }, 10000);

        res.on('close', () => {
          cleanup();
        });

        const finalToolCalls: Record<number, ChatCompletionChunk.Choice.Delta.ToolCall> = {};
        let finish_reason: OllamaChunkResponse['done_reason'] = undefined;
        let reasoning = false;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          const reasoning_content = (delta as { reasoning_content?: string }).reasoning_content;
          const content = delta?.content;

          const toolCalls = delta?.tool_calls;

          // 处理 reasoning_content 和 content 的整合输出
          let outputContent = '';

          match({
            reasoning_content,
            content,
            reasoning: reasoning as boolean,
          })
            .with(
              { reasoning: false, reasoning_content: P.string.minLength(1) },
              ({ reasoning_content }) => {
                reasoning = true;

                const thinkTagChunk = makeOllamaChunk(requestedModel, '<think>', false);
                res.write(makeSSEMessage(thinkTagChunk));

                outputContent = reasoning_content;
              },
            )
            .with(
              { reasoning: true, reasoning_content: P.string.minLength(1) },
              ({ reasoning_content }) => {
                outputContent = reasoning_content ?? '';
              },
            )
            .with(
              { reasoning: true, content: P.string.minLength(1) },
              ({ reasoning_content, content }) => {
                reasoning = false;

                if (reasoning_content) {
                  const reasoningChunk = makeOllamaChunk(requestedModel, reasoning_content, false);
                  res.write(makeSSEMessage(reasoningChunk));
                }

                const thinkTagChunk = makeOllamaChunk(requestedModel, '</think>', false);
                res.write(makeSSEMessage(thinkTagChunk));

                outputContent = content;
              },
            )
            .otherwise(() => {
              outputContent = content ?? '';
            });

          if (outputContent) {
            const ollamaChunk = makeOllamaChunk(requestedModel, outputContent, false);
            res.write(makeSSEMessage(ollamaChunk));
          }

          if (toolCalls) {
            for (const toolCall of toolCalls) {
              const { index } = toolCall;

              if (!finalToolCalls[index]) {
                finalToolCalls[index] = {
                  index: toolCall.index,
                  id: toolCall.id,
                  type: toolCall.type,
                  function: {
                    name: toolCall.function?.name || '',
                    arguments: toolCall.function?.arguments || '',
                  },
                };
              } else {
                if (finalToolCalls[index]?.function) {
                  finalToolCalls[index].function.arguments += toolCall.function?.arguments || '';
                }
              }
            }
          }

          const reason = chunk.choices[0]?.finish_reason;
          if (reason) {
            if (reason === 'stop' || reason === 'tool_calls') {
              finish_reason = reason;
            } else {
              finish_reason = 'stop';
            }
          }

          if (chunk.usage) {
            req.log.info({ usage: chunk.usage }, 'CompletionUsage');
          }
        }

        // Send final chunk with tool calls
        const finalChunk = makeOllamaChunk(requestedModel, '', true, finish_reason, finalToolCalls);
        res.write(makeSSEMessage(finalChunk));
        res.end();
      } finally {
        cleanup();
      }
    },
  };
};
