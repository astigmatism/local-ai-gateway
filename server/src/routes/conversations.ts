import { MessageRole, Prisma } from '@prisma/client';
import type { Request } from 'express';
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
import { generateWithLlm } from '../services/llmClient.js';
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

conversationsRouter.get(
  '/users/:userId/conversations',
  asyncHandler(async (req, res) => {
    const userId = parseOwnUserParam(req);

    const conversations = await prisma.conversation.findMany({
      where: { userId, archived: false },
      orderBy: { updatedAt: 'desc' },
      include: conversationSummaryInclude
    });

    res.json({ conversations });
  })
);

conversationsRouter.post(
  '/users/:userId/conversations',
  asyncHandler(async (req, res) => {
    const userId = parseOwnUserParam(req);
    const body = createConversationSchema.parse(req.body ?? {});

    const conversation = await prisma.conversation.create({
      data: {
        userId,
        title: body.title || 'New conversation'
      },
      include: conversationSummaryInclude
    });

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

conversationsRouter.post(
  '/conversations/:conversationId/messages',
  chatRateLimiter,
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const conversationId = uuidParamSchema.parse(req.params.conversationId);
    const body = sendMessageSchema.parse(req.body ?? {});
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
      firstUserPrompt: body.content
    });
    const fallbackTitleShouldUpdate = isPlaceholderConversationTitle(conversation.title, body.content);
    const shouldPersistFallbackTitleNow =
      !config.conversationTitle.enabled &&
      conversationNeedsGeneratedTitle({
        title: conversation.title,
        messageCount: completedMessageCount,
        firstUserPrompt: body.content,
        titleGenerationEnabled: true
      });
    const now = new Date();

    const userMessage = await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.user,
        content: body.content,
        metadata: {
          submittedAt: now.toISOString()
        }
      }
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: now }
    });

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

    let llmResult;
    try {
      llmResult = await generateWithLlm(prompt, { model: llmModel });
    } catch (error) {
      if (fallbackTitleShouldUpdate) {
        await applyFallbackTitleAfterSendFailure(conversationId, body.content);
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

    const assistantMessage = await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.assistant,
        content: llmResult.content,
        metadata: llmResult.metadata as Prisma.InputJsonValue
      }
    });

    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        ...(shouldPersistFallbackTitleNow ? { title: makeFallbackConversationTitle(body.content) } : {})
      },
      include: conversationSummaryInclude
    });

    logger.info(
      {
        conversationId,
        durationMs: Date.now() - startedAt,
        titleGenerationDeferred: titleGenerationNeeded
      },
      'chat_response_completed'
    );

    res.status(201).json({
      userMessage,
      assistantMessage,
      conversation: updatedConversation,
      titleGeneration: {
        needed: titleGenerationNeeded
      }
    });
  })
);
