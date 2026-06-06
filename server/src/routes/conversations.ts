import { MessageRole, Prisma, type Message } from '@prisma/client';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import {
  conversationNeedsGeneratedTitle,
  generateConversationTitle,
  isPlaceholderConversationTitle,
  makeFallbackConversationTitle
} from '../services/conversationTitle.js';
import { generateImageWithLlm, generateWithLlm, generateWithLlmStream, type LlmStreamDoneEvent } from '../services/llmClient.js';
import { generatedImageMetadataFromMessage, generatedImagePath, saveGeneratedImage, type GeneratedImageMessageMetadata } from '../services/generatedImages.js';
import { detectImageIntent, type ImageIntentDetection } from '../services/imageIntent.js';
import { resolveDefaultLlmModel } from '../services/modelSettingsService.js';
import { buildConversationPrompt } from '../services/promptBuilder.js';

export const conversationsRouter = Router();

const chatRateLimiter = createRateLimiter({
  keyPrefix: 'chat-send',
  windowMs: config.rateLimits.chat.windowMs,
  max: config.rateLimits.chat.max,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const titleGenerationRateLimiter = createRateLimiter({
  keyPrefix: 'conversation-title',
  windowMs: config.rateLimits.chat.windowMs,
  max: config.rateLimits.chat.max,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const uuidParamSchema = z.string().uuid();

const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional()
});

const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  archived: z.boolean().optional()
});

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(50000)
});

const generateTitleSchema = z.object({
  source: z.string().trim().min(1).max(80).optional(),
  force: z.boolean().optional()
});

const conversationSummaryInclude = Prisma.validator<Prisma.ConversationInclude>()({
  messages: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      content: true,
      role: true,
      createdAt: true
    }
  },
  _count: {
    select: { messages: true }
  }
});

type ConversationSummaryPayload = Prisma.ConversationGetPayload<{ include: typeof conversationSummaryInclude }>;

interface TitleGenerationEndpointResponse {
  conversation: ConversationSummaryPayload;
  titleGeneration: {
    needed: boolean;
    generated: boolean;
    fallbackUsed: boolean;
    reason?: string;
    model?: string;
  };
}

const titleGenerationInFlight = new Map<string, Promise<TitleGenerationEndpointResponse>>();


interface ConversationStreamStartEvent {
  type: 'start';
  conversationId: string;
  userMessage: Message;
  assistantMessageTempId: string;
  model: string;
  createdAt: string;
  requestKind?: 'chat' | 'image';
  statusMessage?: string;
}

interface ConversationStreamDeltaEvent {
  type: 'delta';
  delta: string;
  content: string;
  generatedAt: string;
}

interface ConversationStreamMetadataEvent {
  type: 'metadata';
  provider: 'ollama';
  endpoint: '/api/generate';
  model: string;
  generatedAt: string;
}

interface ConversationStreamDoneEvent {
  type: 'done';
  assistantMessage: Message;
  conversation: ConversationSummaryPayload;
  titleGeneration: {
    needed: boolean;
  };
  metadata?: Record<string, unknown>;
}

interface ConversationStreamErrorEvent {
  type: 'error';
  message: string;
  code?: string;
  generatedAt: string;
}

type ConversationStreamEvent =
  | ConversationStreamStartEvent
  | ConversationStreamDeltaEvent
  | ConversationStreamMetadataEvent
  | ConversationStreamDoneEvent
  | ConversationStreamErrorEvent;

const isStreamingResponseClosed = (res: Response) => res.writableEnded || res.destroyed;

const flushStreamingResponse = (res: Response) => {
  (res as Response & { flush?: () => void }).flush?.();
};

const writeNdjsonEvent = async (res: Response, event: ConversationStreamEvent) => {
  if (isStreamingResponseClosed(res)) return false;

  const canContinue = res.write(`${JSON.stringify(event)}\n`);
  flushStreamingResponse(res);

  if (!canContinue && !isStreamingResponseClosed(res)) {
    await Promise.race([once(res, 'drain'), once(res, 'close')]);
  }

  return !isStreamingResponseClosed(res);
};

const streamErrorMessage = (error: unknown) => {
  if (error instanceof ApiError && error.expose) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'The model stream failed.';
};

const streamErrorCode = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

const isClientAbortError = (error: unknown) => error instanceof ApiError && error.code === 'LLM_REQUEST_ABORTED';

const currentUserId = (req: Request) => {
  const userId = req.auth?.user.id;
  if (!userId) throw new ApiError(401, 'Authentication required.', 'AUTH_REQUIRED');
  return userId;
};

const parseOwnUserParam = (req: Request) => {
  const userId = uuidParamSchema.parse(req.params.userId);
  if (userId !== currentUserId(req)) {
    throw new ApiError(403, 'You can only access your own conversations.', 'CONVERSATION_FORBIDDEN');
  }
  return userId;
};

const archiveConversationForUser = async (conversationId: string, userId: string) => {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      userId,
      archived: false
    }
  });

  if (!conversation) {
    throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
  }

  return prisma.conversation.update({
    where: { id: conversation.id },
    data: { archived: true }
  });
};

const applyFallbackTitleAfterSendFailure = async (conversationId: string, content: string) => {
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        title: makeFallbackConversationTitle(content),
        updatedAt: new Date()
      }
    });
  } catch (error) {
    logger.warn(
      { errorMessage: error instanceof Error ? error.message : 'Unknown title persistence error', conversationId },
      'Could not save fallback conversation title after send failure'
    );
  }
};

const loadConversationSummaryForUser = async (conversationId: string, userId: string) => {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      userId,
      archived: false
    },
    include: conversationSummaryInclude
  });

  if (!conversation) {
    throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
  }

  return conversation;
};

const loadFirstExchangeMessages = async (conversationId: string) => {
  const [firstUserMessage, firstAssistantMessage] = await Promise.all([
    prisma.message.findFirst({
      where: { conversationId, role: MessageRole.user },
      orderBy: { createdAt: 'asc' }
    }),
    prisma.message.findFirst({
      where: { conversationId, role: MessageRole.assistant },
      orderBy: { createdAt: 'asc' }
    })
  ]);

  return { firstUserMessage, firstAssistantMessage };
};

const messageMetadataForDetection = (detection: ImageIntentDetection, submittedAt: Date) => ({
  submittedAt: submittedAt.toISOString(),
  requestKind: detection.kind,
  routingReason: detection.reason,
  ...(detection.forcedBy ? { forcedBy: detection.forcedBy } : {}),
  ...(detection.originalPrompt.trim() !== detection.prompt ? { originalContent: detection.originalPrompt.trim() } : {})
});

const generatedImageUrl = (conversationId: string, messageId: string) =>
  `/api/conversations/${conversationId}/messages/${messageId}/image`;

const imageAssistantContent = (prompt: string) => `Generated image for: ${prompt}`;

const createImageAssistantMessage = async (conversationId: string, prompt: string, signal?: AbortSignal) => {
  const imageResult = await generateImageWithLlm(prompt, { signal });
  const storedImage = await saveGeneratedImage(imageResult.image);
  const assistantMessageId = randomUUID();
  const metadata: GeneratedImageMessageMetadata = {
    type: 'image',
    image: {
      url: generatedImageUrl(conversationId, assistantMessageId),
      fileName: storedImage.fileName,
      mimeType: storedImage.mimeType,
      sizeBytes: storedImage.sizeBytes,
      prompt,
      model: imageResult.model,
      provider: 'local-ai-llm',
      localAiEndpoint: '/api/images/generate',
      ...(imageResult.metadata.endpoint === '/api/generate' ? { ollamaEndpoint: '/api/generate' as const } : {}),
      generatedAt: new Date().toISOString(),
      ...(storedImage.width !== undefined ? { width: storedImage.width } : {}),
      ...(storedImage.height !== undefined ? { height: storedImage.height } : {})
    },
    generation: imageResult.metadata
  };

  return prisma.message.create({
    data: {
      id: assistantMessageId,
      conversationId,
      role: MessageRole.assistant,
      content: imageAssistantContent(prompt),
      metadata: metadata as unknown as Prisma.InputJsonValue
    }
  });
};

const serveGeneratedImage = async (res: Response, message: Message) => {
  const metadata = generatedImageMetadataFromMessage(message);
  if (!metadata) {
    throw new ApiError(404, 'Generated image not found for this message.', 'GENERATED_IMAGE_NOT_FOUND');
  }

  const filePath = generatedImagePath(metadata.image.fileName);
  let imageBytes: Buffer;
  try {
    imageBytes = await fs.readFile(filePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new ApiError(404, 'Generated image file not found.', 'GENERATED_IMAGE_FILE_NOT_FOUND');
    }
    throw error;
  }

  res.setHeader('Content-Type', metadata.image.mimeType);
  res.setHeader('Content-Length', imageBytes.length.toString());
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(imageBytes);
};

const noTitleGenerationNeededResponse = async (
  conversationId: string,
  userId: string,
  reason: string
): Promise<TitleGenerationEndpointResponse> => ({
  conversation: await loadConversationSummaryForUser(conversationId, userId),
  titleGeneration: {
    needed: false,
    generated: false,
    fallbackUsed: false,
    reason
  }
});

const generateAndSaveConversationTitle = async (
  conversationId: string,
  userId: string
): Promise<TitleGenerationEndpointResponse> => {
  const startedAt = Date.now();
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      userId,
      archived: false
    },
    include: {
      _count: {
        select: { messages: true }
      }
    }
  });

  if (!conversation) {
    throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
  }

  const { firstUserMessage, firstAssistantMessage } = await loadFirstExchangeMessages(conversationId);

  if (!firstUserMessage || !firstAssistantMessage) {
    return noTitleGenerationNeededResponse(conversationId, userId, 'missing_first_exchange');
  }

  if (
    !conversationNeedsGeneratedTitle({
      title: conversation.title,
      messageCount: conversation._count.messages,
      firstUserPrompt: firstUserMessage.content
    })
  ) {
    return noTitleGenerationNeededResponse(conversationId, userId, 'not_eligible');
  }

  const titleResult = await generateConversationTitle(firstUserMessage.content, firstAssistantMessage.content);

  const latestConversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      userId,
      archived: false
    },
    include: {
      _count: {
        select: { messages: true }
      }
    }
  });

  if (!latestConversation) {
    throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
  }

  if (isPlaceholderConversationTitle(latestConversation.title, firstUserMessage.content)) {
    await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        userId,
        archived: false,
        title: latestConversation.title
      },
      data: {
        title: titleResult.title,
        updatedAt: new Date()
      }
    });
  }

  const updatedConversation = await loadConversationSummaryForUser(conversationId, userId);

  logger.info(
    {
      conversationId,
      durationMs: Date.now() - startedAt,
      generated: titleResult.generated,
      fallbackUsed: titleResult.fallbackUsed,
      reason: titleResult.reason,
      model: titleResult.model
    },
    'conversation_title_generation_completed'
  );

  return {
    conversation: updatedConversation,
    titleGeneration: {
      needed: false,
      generated: titleResult.generated,
      fallbackUsed: titleResult.fallbackUsed,
      reason: titleResult.reason,
      model: titleResult.model
    }
  };
};

const listConversationsForUser = (userId: string) =>
  prisma.conversation.findMany({
    where: { userId, archived: false },
    orderBy: { updatedAt: 'desc' },
    include: conversationSummaryInclude
  });

const createConversationForUser = (userId: string, title?: string) =>
  prisma.conversation.create({
    data: {
      userId,
      title: title || 'New conversation'
    },
    include: conversationSummaryInclude
  });

conversationsRouter.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const conversations = await listConversationsForUser(userId);

    res.json({ conversations });
  })
);

conversationsRouter.post(
  '/conversations',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req);
    const body = createConversationSchema.parse(req.body ?? {});
    const conversation = await createConversationForUser(userId, body.title);

    res.status(201).json({ conversation });
  })
);

conversationsRouter.get(
  '/users/:userId/conversations',
  asyncHandler(async (req, res) => {
    const userId = parseOwnUserParam(req);
    const conversations = await listConversationsForUser(userId);

    res.json({ conversations });
  })
);

conversationsRouter.post(
  '/users/:userId/conversations',
  asyncHandler(async (req, res) => {
    const userId = parseOwnUserParam(req);
    const body = createConversationSchema.parse(req.body ?? {});
    const conversation = await createConversationForUser(userId, body.title);

    res.status(201).json({ conversation });
  })
);

conversationsRouter.delete(
  '/users/:userId/conversations/:conversationId',
  asyncHandler(async (req, res) => {
    const userId = parseOwnUserParam(req);
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    const conversation = await archiveConversationForUser(conversationId, userId);

    res.json({ conversation });
  })
);

conversationsRouter.get(
  '/conversations/:conversationId',
  asyncHandler(async (req, res) => {
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    const userId = currentUserId(req);

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        userId,
        archived: false
      },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            loginName: true,
            isAdmin: true,
            mustChangePassword: true,
            isActive: true,
            createdAt: true,
            updatedAt: true
          }
        },
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!conversation) {
      throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
    }

    res.json({ conversation });
  })
);

conversationsRouter.patch(
  '/conversations/:conversationId',
  asyncHandler(async (req, res) => {
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    const body = updateConversationSchema.parse(req.body ?? {});
    const userId = currentUserId(req);

    const existing = await prisma.conversation.findFirst({
      where: { id: conversationId, userId, archived: false }
    });

    if (!existing) {
      throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
    }

    const conversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: body
    });

    res.json({ conversation });
  })
);

conversationsRouter.delete(
  '/conversations/:conversationId',
  asyncHandler(async (req, res) => {
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    const queryUserId = typeof req.query.userId === 'string' ? uuidParamSchema.parse(req.query.userId) : null;
    const userId = currentUserId(req);

    if (queryUserId && queryUserId !== userId) {
      throw new ApiError(403, 'You can only delete your own conversations.', 'CONVERSATION_FORBIDDEN');
    }

    const conversation = await archiveConversationForUser(conversationId, userId);

    res.json({ conversation });
  })
);

conversationsRouter.post(
  '/conversations/:conversationId/generate-title',
  titleGenerationRateLimiter,
  asyncHandler(async (req, res) => {
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    generateTitleSchema.parse(req.body ?? {});
    const userId = currentUserId(req);

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        userId,
        archived: false
      },
      select: { id: true }
    });

    if (!conversation) {
      throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
    }

    const existingRequest = titleGenerationInFlight.get(conversationId);
    if (existingRequest) {
      res.json(await existingRequest);
      return;
    }

    const request = generateAndSaveConversationTitle(conversationId, userId);
    titleGenerationInFlight.set(conversationId, request);

    try {
      res.json(await request);
    } finally {
      if (titleGenerationInFlight.get(conversationId) === request) {
        titleGenerationInFlight.delete(conversationId);
      }
    }
  })
);


conversationsRouter.get(
  '/conversations/:conversationId/messages/:messageId/image',
  asyncHandler(async (req, res) => {
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    const messageId = uuidParamSchema.parse(req.params.messageId);
    const userId = currentUserId(req);

    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        role: MessageRole.assistant,
        conversation: {
          userId,
          archived: false
        }
      }
    });

    if (!message) {
      throw new ApiError(404, 'Generated image not found.', 'GENERATED_IMAGE_NOT_FOUND');
    }

    await serveGeneratedImage(res, message);
  })
);


conversationsRouter.post(
  '/conversations/:conversationId/messages/stream',
  chatRateLimiter,
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    const body = sendMessageSchema.parse(req.body ?? {});
    const detection = detectImageIntent(body.content);
    const content = detection.prompt;
    if (!content) {
      throw new ApiError(400, 'Add a prompt after the slash command before sending.', 'PROMPT_REQUIRED');
    }
    const userId = currentUserId(req);

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        userId,
        archived: false
      },
      include: {
        _count: {
          select: { messages: true }
        }
      }
    });

    if (!conversation) {
      throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
    }

    const completedMessageCount = conversation._count.messages + 2;
    const titleGenerationNeeded = conversationNeedsGeneratedTitle({
      title: conversation.title,
      messageCount: completedMessageCount,
      firstUserPrompt: content
    });
    const fallbackTitleShouldUpdate = isPlaceholderConversationTitle(conversation.title, content);
    const shouldPersistFallbackTitleNow =
      !config.conversationTitle.enabled &&
      conversationNeedsGeneratedTitle({
        title: conversation.title,
        messageCount: completedMessageCount,
        firstUserPrompt: content,
        titleGenerationEnabled: true
      });
    const now = new Date();

    const userMessage = await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.user,
        content,
        metadata: messageMetadataForDetection(detection, now)
      }
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: now }
    });

    const abortController = new AbortController();
    let streamFinished = false;
    const abortOnClose = () => {
      if (!streamFinished) {
        abortController.abort();
      }
    };
    res.on('close', abortOnClose);

    res.status(201);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    (res as Response & { flushHeaders?: () => void }).flushHeaders?.();

    try {
      if (detection.kind === 'image') {
        const startWritten = await writeNdjsonEvent(res, {
          type: 'start',
          conversationId,
          userMessage,
          assistantMessageTempId: `stream-assistant-${randomUUID()}`,
          model: 'local-ai-llm:image-generation',
          createdAt: new Date().toISOString(),
          requestKind: 'image',
          statusMessage: 'Generating image...'
        });

        if (!startWritten) {
          abortController.abort();
          streamFinished = true;
          return;
        }

        const assistantMessage = await createImageAssistantMessage(conversationId, content, abortController.signal);
        const updatedConversation = await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            updatedAt: new Date(),
            ...(shouldPersistFallbackTitleNow ? { title: makeFallbackConversationTitle(content) } : {})
          },
          include: conversationSummaryInclude
        });

        await writeNdjsonEvent(res, {
          type: 'done',
          assistantMessage,
          conversation: updatedConversation,
          titleGeneration: {
            needed: titleGenerationNeeded
          },
          metadata: assistantMessage.metadata as Record<string, unknown>
        });

        streamFinished = true;
        res.end();

        logger.info(
          {
            conversationId,
            durationMs: Date.now() - startedAt,
            titleGenerationDeferred: titleGenerationNeeded,
            streaming: true,
            requestKind: 'image'
          },
          'image_response_stream_completed'
        );
        return;
      }

      const recentMessagesDesc = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: config.conversation.contextMaxMessages
      });

      const recentMessages = recentMessagesDesc.reverse().map((message) => ({
        role: message.role,
        content: message.content
      }));

      const llmModel = await resolveDefaultLlmModel();
      const prompt = buildConversationPrompt(recentMessages, {
        maxMessages: config.conversation.contextMaxMessages,
        maxChars: config.conversation.contextMaxChars,
        modelName: llmModel
      });

      const startWritten = await writeNdjsonEvent(res, {
        type: 'start',
        conversationId,
        userMessage,
        assistantMessageTempId: `stream-assistant-${randomUUID()}`,
        model: llmModel,
        createdAt: new Date().toISOString(),
        requestKind: 'chat'
      });

      if (!startWritten) {
        abortController.abort();
        streamFinished = true;
        return;
      }

      let llmDone: LlmStreamDoneEvent | null = null;

      for await (const event of generateWithLlmStream(prompt, { model: llmModel, signal: abortController.signal })) {
        if (event.type === 'metadata') {
          const keepStreaming = await writeNdjsonEvent(res, event);
          if (!keepStreaming) {
            abortController.abort();
            streamFinished = true;
            return;
          }
          continue;
        }

        if (event.type === 'delta') {
          const keepStreaming = await writeNdjsonEvent(res, {
            type: 'delta',
            delta: event.delta,
            content: event.content,
            generatedAt: event.generatedAt
          });
          if (!keepStreaming) {
            abortController.abort();
            streamFinished = true;
            return;
          }
          continue;
        }

        llmDone = event;
      }

      if (!llmDone) {
        throw new ApiError(502, 'LLM stream ended without a completed response.', 'LLM_STREAM_INCOMPLETE');
      }

      const assistantMessage = await prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.assistant,
          content: llmDone.content,
          metadata: llmDone.metadata as Prisma.InputJsonValue
        }
      });

      const updatedConversation = await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          updatedAt: new Date(),
          ...(shouldPersistFallbackTitleNow ? { title: makeFallbackConversationTitle(content) } : {})
        },
        include: conversationSummaryInclude
      });

      await writeNdjsonEvent(res, {
        type: 'done',
        assistantMessage,
        conversation: updatedConversation,
        titleGeneration: {
          needed: titleGenerationNeeded
        },
        metadata: llmDone.metadata
      });

      streamFinished = true;
      res.end();

      logger.info(
        {
          conversationId,
          durationMs: Date.now() - startedAt,
          titleGenerationDeferred: titleGenerationNeeded,
          streaming: true,
          requestKind: 'chat'
        },
        'chat_response_stream_completed'
      );
    } catch (error) {
      if (abortController.signal.aborted || isClientAbortError(error) || res.destroyed) {
        streamFinished = true;
        logger.info(
          {
            conversationId,
            durationMs: Date.now() - startedAt,
            streaming: true,
            requestKind: detection.kind
          },
          'chat_response_stream_aborted'
        );
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }

      if (fallbackTitleShouldUpdate) {
        await applyFallbackTitleAfterSendFailure(conversationId, content);
      }

      logger.error(
        {
          conversationId,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : 'Unknown stream error',
          code: streamErrorCode(error),
          requestKind: detection.kind
        },
        detection.kind === 'image' ? 'image_response_stream_failed' : 'chat_response_stream_failed'
      );

      await writeNdjsonEvent(res, {
        type: 'error',
        message: `${streamErrorMessage(error)} Your user message was saved in the conversation.`,
        code: streamErrorCode(error),
        generatedAt: new Date().toISOString()
      });

      streamFinished = true;
      res.end();
    } finally {
      res.off('close', abortOnClose);
    }
  })
);

conversationsRouter.post(
  '/conversations/:conversationId/messages',
  chatRateLimiter,
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    const body = sendMessageSchema.parse(req.body ?? {});
    const detection = detectImageIntent(body.content);
    const content = detection.prompt;
    if (!content) {
      throw new ApiError(400, 'Add a prompt after the slash command before sending.', 'PROMPT_REQUIRED');
    }
    const userId = currentUserId(req);

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        userId,
        archived: false
      },
      include: {
        _count: {
          select: { messages: true }
        }
      }
    });

    if (!conversation) {
      throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
    }

    const completedMessageCount = conversation._count.messages + 2;
    const titleGenerationNeeded = conversationNeedsGeneratedTitle({
      title: conversation.title,
      messageCount: completedMessageCount,
      firstUserPrompt: content
    });
    const fallbackTitleShouldUpdate = isPlaceholderConversationTitle(conversation.title, content);
    const shouldPersistFallbackTitleNow =
      !config.conversationTitle.enabled &&
      conversationNeedsGeneratedTitle({
        title: conversation.title,
        messageCount: completedMessageCount,
        firstUserPrompt: content,
        titleGenerationEnabled: true
      });
    const now = new Date();

    const userMessage = await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.user,
        content,
        metadata: messageMetadataForDetection(detection, now)
      }
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: now }
    });

    let assistantMessage: Message;
    let responseMetadata: Record<string, unknown> | undefined;

    try {
      if (detection.kind === 'image') {
        assistantMessage = await createImageAssistantMessage(conversationId, content);
        responseMetadata = assistantMessage.metadata as Record<string, unknown>;
      } else {
        const recentMessagesDesc = await prisma.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: 'desc' },
          take: config.conversation.contextMaxMessages
        });

        const recentMessages = recentMessagesDesc.reverse().map((message) => ({
          role: message.role,
          content: message.content
        }));

        const llmModel = await resolveDefaultLlmModel();
        const prompt = buildConversationPrompt(recentMessages, {
          maxMessages: config.conversation.contextMaxMessages,
          maxChars: config.conversation.contextMaxChars,
          modelName: llmModel
        });

        const llmResult = await generateWithLlm(prompt, { model: llmModel });
        assistantMessage = await prisma.message.create({
          data: {
            conversationId,
            role: MessageRole.assistant,
            content: llmResult.content,
            metadata: llmResult.metadata as Prisma.InputJsonValue
          }
        });
        responseMetadata = llmResult.metadata;
      }
    } catch (error) {
      if (fallbackTitleShouldUpdate) {
        await applyFallbackTitleAfterSendFailure(conversationId, content);
      }

      if (error instanceof ApiError) {
        throw new ApiError(
          error.statusCode,
          `${error.message} Your user message was saved in the conversation.`,
          error.code,
          { userMessage },
          error.expose
        );
      }
      throw error;
    }

    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        ...(shouldPersistFallbackTitleNow ? { title: makeFallbackConversationTitle(content) } : {})
      },
      include: conversationSummaryInclude
    });

    logger.info(
      {
        conversationId,
        durationMs: Date.now() - startedAt,
        titleGenerationDeferred: titleGenerationNeeded,
        requestKind: detection.kind
      },
      detection.kind === 'image' ? 'image_response_completed' : 'chat_response_completed'
    );

    res.status(201).json({
      userMessage,
      assistantMessage,
      conversation: updatedConversation,
      titleGeneration: {
        needed: titleGenerationNeeded
      },
      metadata: responseMetadata
    });
  })
);
