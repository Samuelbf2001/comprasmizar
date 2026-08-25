import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson } from "../../../lib/http/api";
import { createSupplierServiceDependencies } from "../../../lib/infrastructure/supplier-repositories";
import { SupplierService } from "../../../lib/services";

export const runtime = "nodejs";
const name = z.string().trim().min(2).max(160);
const nit = z.string().trim().min(3).max(32);
/** An unknown NIT must remain nullable: normalization is handled by the database generated key. */
const optionalNit = z.preprocess((value) => typeof value === "string" && value.trim() === "" ? null : value, nit.nullable().optional());
const contact = z.object({ name: z.string().trim().min(2).max(160).optional(), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/).optional(), email: z.string().trim().email().max(254).optional(), address: z.string().trim().min(1).max(300).optional() }).strict();
const bankDetails = z.object({ bankName: z.string().trim().min(2).max(120).optional(), accountType: z.enum(["ahorros", "corriente"]).optional(), accountNumber: z.string().trim().regex(/^[0-9 -]{4,40}$/).optional(), accountHolder: z.string().trim().min(2).max(160).optional(), accountHolderNit: z.string().trim().min(3).max(32).optional() }).strict();
/** RF-603: review can create a selectable supplier with business name alone while NIT is pending. */
export const supplierCreateSchema = z.object({ name, nit: optionalNit, contact: contact.optional(), bankDetails: bankDetails.optional(), active: z.boolean().optional() }).strict();

function service() { return new SupplierService(createSupplierServiceDependencies()); }
export function GET() { return authenticatedJson((actor) => service().list(actor)); }
export function POST(request: Request) { return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, supplierCreateSchema); return service().create(input, actor); }, 201); }
