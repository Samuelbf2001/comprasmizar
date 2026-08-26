import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveKapsoMediaDownloadUrl } from "../../lib/infrastructure/nfm-reply-adapter";

// Guardian del bug que el validador encontro con una llamada en vivo: el proxy de Kapso
// exige phone_number_id en la query de /media. Sin el respondia 404 y TODA la evidencia
// (fotos/PDF) de solicitudes reales se perdia en silencio. Los tests que inyectan un mock
// de resolveAttachmentUrl nunca ejercitan esta funcion, por eso no lo detectaron.
describe("resolveKapsoMediaDownloadUrl exige phone_number_id", () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    process.env.KAPSO_API_KEY = "clave-de-prueba";
    process.env.KAPSO_META_PROXY_URL = "https://proxy.example/meta/v24.0";
    process.env.KAPSO_PHONE_NUMBER_ID = "1221974497672719";
  });
  afterEach(() => { process.env = { ...ORIG }; vi.restoreAllMocks(); });

  it("incluye el phone_number_id de la linea en la URL de descarga", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ download_url: "https://cdn.example/archivo.pdf" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const url = await resolveKapsoMediaDownloadUrl("media-abc-123");
    expect(url).toBe("https://cdn.example/archivo.pdf");
    const llamada = String(fetchMock.mock.calls[0]?.[0]);
    expect(llamada).toContain("media-abc-123");
    expect(llamada).toContain("phone_number_id=1221974497672719");
  });

  it("falla cerrado (null) si falta el phone_number_id de la linea", async () => {
    delete process.env.KAPSO_PHONE_NUMBER_ID;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const url = await resolveKapsoMediaDownloadUrl("media-abc-123");
    expect(url).toBeNull();
    // No debe ni intentar la llamada sin la config completa.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
