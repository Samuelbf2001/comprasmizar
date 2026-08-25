import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
export function hmacSha256(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("hex"); }
export function verifyKapsoSignature(raw: string, signature: string | null, secret: string): boolean { if (!signature) return false; const supplied = signature.replace(/^sha256=/i, ""); return safeEqual(hmacSha256(raw, secret), supplied); }
