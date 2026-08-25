import { z } from "zod";

const httpsUrl = z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const itemIdentity = {
  itemId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500).optional(),
  quantity: z.number().finite().positive().max(1_000_000),
  unit: z.string().trim().min(1).max(40),
  possibleSupplier: z.string().trim().min(1).max(240).optional(),
  productLink: httpsUrl.optional(),
};

export const createRequisitionSchema = z.object({
  type: z.enum(["compra", "pago"]),
  workId: z.string().uuid(),
  requesterId: z.string().uuid().optional(),
  requiredDate: z.string().date(),
  destination: z.string().trim().min(1).max(500).optional(),
  observations: z.string().trim().min(1).max(3_000).optional(),
  items: z.array(z.object(itemIdentity).strict().refine((item) => Boolean(item.itemId || item.description), "itemId or description is required")).min(1).max(100),
}).strict();

export const reviewedItemSchema = z.object({
  id: z.string().uuid(),
  ...itemIdentity,
  finalSupplierId: z.string().uuid().optional(),
  unitBase: z.number().int().nonnegative(),
  unitIva: z.number().int().nonnegative(),
}).strict().refine((item) => Boolean(item.itemId || item.description), "itemId or description is required");

export const requisitionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_review") }).strict(),
  z.object({ action: z.literal("review"), tagId: z.string().uuid(), items: z.array(reviewedItemSchema).min(1).max(100) }).strict(),
  z.object({ action: z.literal("send_for_approval") }).strict(),
  z.object({ action: z.literal("approve"), multiSupplier: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("return"), comment: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ action: z.literal("decline"), reason: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ action: z.literal("propose_item"), description: z.string().trim().min(1).max(500) }).strict(),
]);

export const orderStatusSchema = z.object({ status: z.enum(["cumplida", "no_cumplida", "no_necesario"]) }).strict();
export const expenseSharesSchema = z.object({ total: z.number().int().positive(), shares: z.array(z.object({ workId: z.string().uuid(), amount: z.number().int().positive() }).strict()).min(1).max(100) }).strict();
export const pettyCashSchema = z.object({ workId: z.string().uuid(), date: z.string().date(), concept: z.string().trim().min(1).max(500), tagId: z.string().uuid(), amount: z.number().int().positive() }).strict();
