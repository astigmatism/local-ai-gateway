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
  generateConversationTitle,
  isGenericConversationTitle,
  makeFallbackConversationTitle
} from '../services/conversationTitle.js';
import { generateWithLlm } from '../services/llmClient.js';
import { buildConversationPrompt } from '../services/promptBuilder.js';

export const conversationsRouter = Router();

const chatRateLimiter = createRateLimiter({
  keyPrefix: 'chat-send',
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
  '/conversations/:conversationId/messages',
  chatRateLimiter,
  asyncHandler(async (req, res) => {
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

    const titleShouldUpdate = isGenericConversationTitle(conversation.title);
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

    const prompt = buildConversationPrompt(recentMessages, {
      maxMessages: config.conversation.contextMaxMessages,
      maxChars: config.conversation.contextMaxChars,
      modelName: config.llm.model
    });

    let llmResult;
    try {
      llmResult = await generateWithLlm(prompt);
    } catch (error) {
      if (titleShouldUpdate) {
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

    const titleResult = titleShouldUpdate ? await generateConversationTitle(body.content) : null;
    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        ...(titleResult ? { title: titleResult.title } : {})
      },
      include: conversationSummaryInclude
    });

    res.status(201).json({
      userMessage,
      assistantMessage,
      conversation: updatedConversation
    });
  })
);
