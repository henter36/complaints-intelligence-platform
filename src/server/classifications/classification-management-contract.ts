import { z } from "zod";

export const createCategoryPayloadSchema = z
  .object({
    name: z.string().min(1, "اسم الفئة مطلوب"),
    description: z.string().nullable().optional(),
    displayOrder: z.number().int().optional(),
  })
  .strict();

export const updateCategoryPayloadSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    displayOrder: z.number().int().optional(),
  })
  .strict();

export const createClassificationPayloadSchema = z
  .object({
    categoryId: z.string().min(1, "معرّف الفئة مطلوب"),
    name: z.string().min(1, "اسم التصنيف مطلوب"),
    description: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

export const updateClassificationPayloadSchema = z
  .object({
    categoryId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();
