import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Migración a autoalojado (2026-09-10): lib/infrastructure/local-storage.ts reemplaza los URLs
// firmados de Supabase Storage. Es la capa donde un error no da un fallo visible sino una fuga
// silenciosa — un token que sirve para más de lo que debería, o una ruta que se escapa del bucket —
// así que se prueba el contrato de autorización, no solo el camino feliz.
const ROOT = mkdtempSync(join(tmpdir(), "mizar-storage-"));
process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
process.env.STORAGE_ROOT = ROOT;
process.env.STORAGE_SIGNING_SECRET = "s".repeat(32);

const {
  assertSafeObjectPath, createStorageToken, verifyStorageToken, writeObject, readObject, readObjectInfo, createLocalBucketStorage,
} = await import("../../lib/infrastructure/local-storage");

const BUCKET = "requisicion-adjuntos";
const PDF = Buffer.from("%PDF-1.4 contenido de prueba");

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe("rutas de objeto: la forma se valida antes de tocar el disco", () => {
  it("acepta las rutas que produce el servicio de adjuntos", () => {
    expect(assertSafeObjectPath("requisiciones/11111111-1111-4111-8111-111111111111/222/factura.pdf")).toBeTruthy();
  });

  it("rechaza todo lo que podría escaparse del bucket", () => {
    for (const malicious of [
      "../secretos.pdf",
      "requisiciones/../../etc/passwd",
      "/etc/passwd",
      "requisiciones\\..\\otro.pdf", // backslash de Windows: no es separador válido aquí
      "",
      "requisiciones//doble.pdf",    // segmento vacío
      ".oculto/archivo.pdf",         // segmento que empieza por punto
      "requisiciones/./aqui.pdf",
    ]) {
      expect(() => assertSafeObjectPath(malicious), `debió rechazar: ${malicious}`).toThrow("STORAGE_PATH_INVALID");
    }
  });
});

describe("tokens firmados: autorizan UNA ruta y UNA operación", () => {
  it("ida y vuelta de un token válido", () => {
    const token = createStorageToken(BUCKET, "requisiciones/a/b/x.pdf", "get", 60);
    expect(verifyStorageToken(token, "get")).toEqual({ bucket: BUCKET, objectPath: "requisiciones/a/b/x.pdf", operation: "get" });
  });

  it("un token de lectura NO sirve para escribir, ni al revés", () => {
    // Sin esto, quien recibe un enlace de descarga podría sobrescribir el soporte que descarga.
    expect(verifyStorageToken(createStorageToken(BUCKET, "a/b/x.pdf", "get", 60), "put")).toBeNull();
    expect(verifyStorageToken(createStorageToken(BUCKET, "a/b/x.pdf", "put", 60), "get")).toBeNull();
  });

  it("rechaza un token vencido", () => {
    expect(verifyStorageToken(createStorageToken(BUCKET, "a/b/x.pdf", "get", -1), "get")).toBeNull();
  });

  it("rechaza una firma alterada y un payload alterado", () => {
    const token = createStorageToken(BUCKET, "a/b/x.pdf", "get", 60);
    const [version, payload, signature] = token.split(".");
    expect(verifyStorageToken(`${version}.${payload}.${signature.slice(0, -2)}xx`, "get")).toBeNull();
    // Cambiar la ruta reclamada sin poder re-firmarla: es el ataque que el HMAC existe para frenar.
    const otro = Buffer.from(JSON.stringify({ b: BUCKET, p: "requisiciones/de-otro/secreto.pdf", o: "get", e: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    expect(verifyStorageToken(`${version}.${otro}.${signature}`, "get")).toBeNull();
  });

  it("rechaza basura sin reventar", () => {
    for (const junk of ["", "no-es-un-token", "v1.solo-dos.partes.de-mas", "v2.abc.def"]) {
      expect(verifyStorageToken(junk, "get")).toBeNull();
    }
  });
});

describe("escritura y lectura en disco", () => {
  let path: string;
  beforeEach(() => { path = `requisiciones/${crypto.randomUUID()}/${crypto.randomUUID()}/factura.pdf`; });

  it("guarda, informa el tamaño real y devuelve el contenido", async () => {
    await writeObject(BUCKET, path, PDF, "application/pdf");
    expect(await readObjectInfo(BUCKET, path)).toEqual({ sizeBytes: PDF.byteLength, mimeType: "application/pdf" });
    const leido = await readObject(BUCKET, path);
    expect(leido?.bytes.equals(PDF)).toBe(true);
  });

  it("no sobrescribe un objeto ya existente (upsert: false de Supabase)", async () => {
    // Un soporte ya auditado no puede cambiar por debajo: reintentar la subida falla en vez de pisar.
    await writeObject(BUCKET, path, PDF, "application/pdf");
    await expect(writeObject(BUCKET, path, Buffer.from("%PDF-1.4 otro"), "application/pdf")).rejects.toThrow("STORAGE_OBJECT_EXISTS");
  });

  it("info() y readObject() devuelven null para lo que no existe", async () => {
    expect(await readObjectInfo(BUCKET, "requisiciones/no/existe/x.pdf")).toBeNull();
    expect(await readObject(BUCKET, "requisiciones/no/existe/x.pdf")).toBeNull();
  });

  it("el MIME que informa es el que se guardó, no el que declare quien lee", async () => {
    // `PrivateAttachmentService.confirm` compara lo declarado por el navegador contra esto. Si esto
    // devolviera el dato declarado, la verificación sería un eco y no comprobaría nada.
    await writeObject(BUCKET, path, PDF, "application/pdf");
    expect((await readObjectInfo(BUCKET, path))?.mimeType).toBe("application/pdf");
  });
});

describe("createLocalBucketStorage cumple el contrato que espera la capa de servicio", () => {
  it("emite URLs relativas del propio origen, con token verificable", async () => {
    const storage = createLocalBucketStorage(BUCKET);
    const path = `requisiciones/${crypto.randomUUID()}/${crypto.randomUUID()}/foto.pdf`;
    const { url } = await storage.createUploadUrl(path);
    expect(url.startsWith("/api/storage/object?token=")).toBe(true);
    const token = new URL(url, "http://localhost").searchParams.get("token") as string;
    expect(verifyStorageToken(token, "put")).toMatchObject({ bucket: BUCKET, objectPath: path });

    const download = await storage.createDownloadUrl(path, 60);
    const downloadToken = new URL(download, "http://localhost").searchParams.get("token") as string;
    expect(verifyStorageToken(downloadToken, "get")).toMatchObject({ objectPath: path });
  });
});
