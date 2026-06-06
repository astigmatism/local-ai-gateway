import { Prisma, type User } from '@prisma/client';
import fs from 'node:fs/promises';
import { isEricAdmin } from '../auth/identity.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import { generatedImagePath, isGeneratedImageMetadata } from './generatedImages.js';

interface PurgeUserOptions {
  currentUserId: string;
  targetUserId: string;
}

export interface GeneratedImageFilePurgeSummary {
  referenced: number;
  deleted: number;
  missing: number;
  failed: number;
}

export interface UserPurgeSummary {
  authSessions: number;
  messages: number;
  conversations: number;
  audioSnippets: number;
  generatedImageFiles: GeneratedImageFilePurgeSummary;
}

export interface UserPurgeResult {
  user: User;
  deleted: UserPurgeSummary;
}

type TransactionClient = Prisma.TransactionClient;

type MessageMetadataRow = {
  metadata: Prisma.JsonValue | null;
};

const collectGeneratedImageFileNames = (messages: MessageMetadataRow[]) => {
  const fileNames = new Set<string>();

  for (const message of messages) {
    if (isGeneratedImageMetadata(message.metadata)) {
      fileNames.add(message.metadata.image.fileName);
    }
  }

  return [...fileNames];
};

const isEnoent = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');

const deleteGeneratedImageFiles = async (fileNames: string[]): Promise<GeneratedImageFilePurgeSummary> => {
  const summary: GeneratedImageFilePurgeSummary = {
    referenced: fileNames.length,
    deleted: 0,
    missing: 0,
    failed: 0
  };

  for (const fileName of fileNames) {
    let filePath: string;
    try {
      filePath = generatedImagePath(fileName);
    } catch (error) {
      summary.failed += 1;
      logger.warn(
        {
          fileName,
          errorMessage: error instanceof Error ? error.message : 'Invalid generated image metadata'
        },
        'Skipping invalid generated image reference during user purge'
      );
      continue;
    }

    try {
      await fs.unlink(filePath);
      summary.deleted += 1;
    } catch (error) {
      if (isEnoent(error)) {
        summary.missing += 1;
        continue;
      }

      summary.failed += 1;
      logger.warn(
        {
          fileName,
          errorMessage: error instanceof Error ? error.message : 'Unknown generated image deletion error'
        },
        'Could not delete generated image file during user purge'
      );
    }
  }

  return summary;
};

const assertUserCanBePurged = async (tx: TransactionClient, currentUserId: string, target: User) => {
  if (target.id === currentUserId) {
    throw new ApiError(400, 'You cannot delete your own account.', 'CANNOT_DELETE_SELF');
  }

  if (isEricAdmin(target)) {
    throw new ApiError(400, 'The default administrator cannot be deleted through user management.', 'CANNOT_DELETE_BOOTSTRAP_ADMIN');
  }

  if (target.isAdmin) {
    const remainingActiveAdminCount = await tx.user.count({
      where: {
        id: { not: target.id },
        isAdmin: true,
        isActive: true,
        deletedAt: null
      }
    });

    if (remainingActiveAdminCount === 0) {
      throw new ApiError(400, 'You cannot delete the last administrator.', 'CANNOT_DELETE_LAST_ADMIN');
    }
  }
};

export const purgeUser = async ({ currentUserId, targetUserId }: PurgeUserOptions): Promise<UserPurgeResult> => {
  const purgeResult = await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new ApiError(404, 'User not found.', 'USER_NOT_FOUND');

    await assertUserCanBePurged(tx, currentUserId, target);

    const generatedImageMessages = await tx.message.findMany({
      where: {
        conversation: {
          userId: target.id
        }
      },
      select: {
        metadata: true
      }
    });
    const generatedImageFileNames = collectGeneratedImageFileNames(generatedImageMessages);

    const deletedMessages = await tx.message.deleteMany({
      where: {
        conversation: {
          userId: target.id
        }
      }
    });
    const deletedAudioSnippets = await tx.audioSnippet.deleteMany({ where: { userId: target.id } });
    const deletedConversations = await tx.conversation.deleteMany({ where: { userId: target.id } });
    const deletedAuthSessions = await tx.authSession.deleteMany({ where: { userId: target.id } });
    await tx.user.delete({ where: { id: target.id } });

    return {
      user: target,
      generatedImageFileNames,
      deleted: {
        authSessions: deletedAuthSessions.count,
        messages: deletedMessages.count,
        conversations: deletedConversations.count,
        audioSnippets: deletedAudioSnippets.count
      }
    };
  });

  const generatedImageFiles = await deleteGeneratedImageFiles(purgeResult.generatedImageFileNames);

  return {
    user: purgeResult.user,
    deleted: {
      ...purgeResult.deleted,
      generatedImageFiles
    }
  };
};
