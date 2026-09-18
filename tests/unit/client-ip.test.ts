import { describe, expect, it } from "vitest";
import { clientIpFrom } from "../../lib/security/client-ip";

const headersWith = (init: Record<string, string>) => new Headers(init);

describe("clientIpFrom", () => {
  it("toma la entrada que añade el proxy (la última), no la que escribe el cliente", () => {
    expect(clientIpFrom(headersWith({ "x-forwarded-for": "1.2.3.4, 181.50.60.70" }))).toBe("181.50.60.70");
  });

  it("ignora una X-Real-IP falsa: no mueve la clave del limitador", () => {
    const real = clientIpFrom(headersWith({ "x-forwarded-for": "181.50.60.70" }));
    const spoofed = clientIpFrom(headersWith({ "x-forwarded-for": "181.50.60.70", "x-real-ip": "10.9.8.7" }));
    expect(spoofed).toBe(real);
  });

  it("rotar la parte izquierda de X-Forwarded-For no estrena cupo", () => {
    const keys = ["10.0.0.1", "10.0.0.2", "10.0.0.3"].map((fake) => clientIpFrom(headersWith({ "x-forwarded-for": `${fake}, 181.50.60.70` })));
    expect(new Set(keys)).toEqual(new Set(["181.50.60.70"]));
  });

  it("tolera espacios y entradas vacías", () => {
    expect(clientIpFrom(headersWith({ "x-forwarded-for": " 1.2.3.4 ,, 181.50.60.70 , " }))).toBe("181.50.60.70");
  });

  it("sin X-Forwarded-For no confía en otra cabecera del cliente", () => {
    expect(clientIpFrom(headersWith({ "x-real-ip": "10.9.8.7" }))).toBe("direct");
    expect(clientIpFrom(headersWith({}))).toBe("direct");
  });
});
