import { z } from "zod";
export type EnvSource = Readonly<Record<string, string | undefined>>;
/**
 * Migración a autoalojado (2026-09-10): salieron las tres variables de Supabase
 * (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY) y entraron las dos del almacenamiento en
 * disco propio. La autenticación no añadió ninguna: las sesiones son tokens aleatorios guardados
 * hasheados en la base (lib/infrastructure/local-auth.ts), así que no hay llave que configurar.
 *
 * `STORAGE_ROOT` es obligatoria y sin valor por defecto a propósito: un default absoluto tipo
 * `/var/lib/mizar/storage` haría que un entorno mal configurado escribiera soportes en una ruta que
 * nadie respalda, en silencio. Mejor que arranque fallando y lo diga.
 */
const coreSchema = z.object({ DATABASE_URL: z.string().url(), STORAGE_ROOT: z.string().min(1), STORAGE_SIGNING_SECRET: z.string().min(32) });
const publicSchema = coreSchema.extend({ PUBLIC_FORM_CODE_PEPPER: z.string().min(32) }); const kapsoSchema = coreSchema.extend({ KAPSO_WEBHOOK_SECRET: z.string().min(32) }); const mcpSchema = coreSchema.extend({ MCP_KEY_PEPPER: z.string().min(32) });
export type RuntimeEnv = z.infer<typeof coreSchema>; export type PublicEnv = z.infer<typeof publicSchema>; export type KapsoEnv = z.infer<typeof kapsoSchema>; export type McpEnv = z.infer<typeof mcpSchema>;
export function runtimeEnv(source: EnvSource = process.env): RuntimeEnv { return coreSchema.parse(source); } export function publicEnv(source: EnvSource = process.env): PublicEnv { return publicSchema.parse(source); } export function kapsoEnv(source: EnvSource = process.env): KapsoEnv { return kapsoSchema.parse(source); } export function mcpEnv(source: EnvSource = process.env): McpEnv { return mcpSchema.parse(source); }
export function isRuntimeConfigured(source: EnvSource = process.env): boolean { return coreSchema.safeParse(source).success; } export function isPublicConfigured(source: EnvSource = process.env): boolean { return publicSchema.safeParse(source).success; } export function isKapsoConfigured(source: EnvSource = process.env): boolean { return kapsoSchema.safeParse(source).success; } export function isMcpConfigured(source: EnvSource = process.env): boolean { return mcpSchema.safeParse(source).success; }
