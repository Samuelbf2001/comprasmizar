import { describe, expect, it } from "vitest";
import { GENERAL_LINK_SCOPE, generalLinkToken, verifyPublicLinkToken } from "../../lib/security/public-link";
import { hmacSha256 } from "../../lib/security/crypto";

// El enlace del portal pasó de ser por obra a tener también una variante GENERAL (petición del
// cliente: "debe ser un link general para montar las requisiciones"). Ese cambio amplía lo que un
// token autoriza, así que lo que se prueba aquí es el límite: qué abre cada token y qué no.
const PEPPER = "p".repeat(40);
const OBRA_A = "0198f3a1-7c4d-4e2b-9f1a-2b3c4d5e6f70";
const OBRA_B = "0198f3a1-7c4d-4e2b-9f1a-2b3c4d5e6f71";

describe("tokens de enlace del portal público", () => {
  it("un token por obra abre ESA obra", () => {
    expect(verifyPublicLinkToken(OBRA_A, hmacSha256(OBRA_A, PEPPER), PEPPER)).toBe(true);
  });

  it("un token por obra NO abre otra obra", () => {
    // Es la propiedad que hace útil el enlace por obra: repartirlo no da acceso al resto.
    expect(verifyPublicLinkToken(OBRA_B, hmacSha256(OBRA_A, PEPPER), PEPPER)).toBe(false);
  });

  it("el token general abre cualquier obra — es justamente para lo que existe", () => {
    const general = generalLinkToken(PEPPER);
    expect(verifyPublicLinkToken(OBRA_A, general, PEPPER)).toBe(true);
    expect(verifyPublicLinkToken(OBRA_B, general, PEPPER)).toBe(true);
  });

  it("el token general depende del pepper: con otro pepper no vale", () => {
    expect(verifyPublicLinkToken(OBRA_A, generalLinkToken("otro".repeat(10)), PEPPER)).toBe(false);
  });

  it("el ámbito general no puede confundirse con una obra", () => {
    // Si alguien registrara una obra cuyo id fuese la cadena del ámbito, su token por obra sería el
    // token general. No puede pasar (los ids son uuid), pero conviene que quede fijado por escrito.
    expect(GENERAL_LINK_SCOPE).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("rechaza basura sin reventar", () => {
    for (const junk of ["", "no-es-un-token", "0".repeat(64), hmacSha256(OBRA_A, PEPPER).slice(0, -1)]) {
      expect(verifyPublicLinkToken(OBRA_A, junk, PEPPER), `debió rechazar: ${junk}`).toBe(false);
    }
  });
});
