import { z } from 'zod';

export const COMMENT_ENTITY_TYPES = ['contact', 'deal', 'task'] as const;

export const createCommentSchema = z
  .object({
    entityType: z.enum(COMMENT_ENTITY_TYPES),
    entityId: z.string().uuid(),
    body: z.string().trim().min(1, 'Comment body is required').max(10000),
  })
  .strict();

export const updateCommentSchema = z
  .object({
    body: z.string().trim().min(1, 'Comment body is required').max(10000),
  })
  .strict();

export const listCommentsQuerySchema = z
  .object({
    entityType: z.enum(COMMENT_ENTITY_TYPES),
    entityId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const ATTACHMENT_ENTITY_TYPES = ['contact', 'deal', 'task'] as const;

export const listAttachmentsQuerySchema = z
  .object({
    entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
    entityId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsQuerySchema>;
