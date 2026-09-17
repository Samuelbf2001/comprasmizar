import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_MIME_TYPES,
  uploadSignedAttachment,
  validateAttachmentFile,
} from "../../components/screens/attachment-upload";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("adjuntos operativos", () => {
  it("mantiene metadata exacta y hace prepare -> FormData PUT -> complete con el id preparado", async () => {
    const file = new File(["foto"], "frente.png", { type: "image/png" });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/attachments/requisicion_item/item-1")
        return response({
          attachment: { id: "attachment-42" },
          upload: {
            url: "https://signed.invalid/private-put",
            method: "PUT",
            multipart: { cacheControl: "3600", fileField: "" },
          },
        });
      if (url === "https://signed.invalid/private-put") return response({});
      return response({ attachment: { id: "attachment-42" } });
    });
    const metadata = {
      type: "foto",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    };

    await uploadSignedAttachment({
      prepareUrl: "/api/attachments/requisicion_item/item-1",
      completeUrl: (id) => `/api/attachments/requisicion_item/item-1/${id}/complete`,
      file,
      metadata,
      fetcher,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "/api/attachments/requisicion_item/item-1",
      "https://signed.invalid/private-put",
      "/api/attachments/requisicion_item/item-1/attachment-42/complete",
    ]);
    expect(calls[0].init?.body).toBe(JSON.stringify(metadata));
    expect(calls[1].init?.headers).toBeUndefined();
    expect(calls[1].init?.body).toBeInstanceOf(FormData);
    const multipart = calls[1].init?.body as FormData;
    expect(multipart.get("cacheControl")).toBe("3600");
    expect(multipart.get("")).toBe(file);
    expect(calls[2].init?.body).toBe(JSON.stringify(metadata));
    expect(calls.map((call) => call.url).join(" ")).not.toContain("token");
  });

  it("rechaza mime y tamaño antes de preparar", () => {
    // 2026-09-17: la lista se amplió (Excel, Word, CSV, texto), pero sigue siendo CERRADA — lo que
    // no está dentro se rechaza igual que antes, y el mensaje nombra lo que sí se admite.
    const badMime = new File(["x"], "dibujo.svg", { type: "image/svg+xml" });
    expect(validateAttachmentFile(badMime)).toMatch(/PDF, Excel, Word, CSV o imagen/);
    const oversized = new File([new Uint8Array(11 * 1024 * 1024)], "large.pdf", {
      type: "application/pdf",
    });
    expect(validateAttachmentFile(oversized)).toMatch(/10 MB/);
  });

  it("admite los formatos con los que cobra un proveedor: Excel, CSV y texto", () => {
    for (const [name, type] of [
      ["cantidades.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["presupuesto.xls", "application/vnd.ms-excel"],
      ["cuenta-de-cobro.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["lista.csv", "text/csv"],
      ["notas.txt", "text/plain"],
    ]) {
      expect(validateAttachmentFile(new File(["x"], name, { type })), name).toBe("");
    }
    // Y el selector de FOTOS sigue siendo solo de fotos: la ampliación no lo tocó.
    expect(
      validateAttachmentFile(new File(["x"], "cantidades.xlsx", { type: "application/vnd.ms-excel" }), {
        allowedMimeTypes: IMAGE_MIME_TYPES,
      }),
    ).toMatch(/JPG, PNG o WebP/);
  });

  it("acepta WebP para las fotos operativas", () => {
    const webp = new File(["webp"], "frente.webp", { type: "image/webp" });
    expect(validateAttachmentFile(webp, { allowedMimeTypes: IMAGE_MIME_TYPES })).toBe("");
  });

  it("no completa si prepare no devuelve id o multipart", async () => {
    const file = new File(["x"], "support.pdf", { type: "application/pdf" });
    const fetcher = vi.fn(async () =>
      response({
        attachment: { id: "attachment-1" },
        upload: { url: "https://signed.invalid/no-multipart", method: "PUT" },
      }),
    );
    await expect(
      uploadSignedAttachment({
        prepareUrl: "/prepare",
        completeUrl: (id) => `/complete/${id}`,
        file,
        metadata: {
          type: "soporte",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        },
        fetcher,
      }),
    ).rejects.toThrow(/multipart/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
