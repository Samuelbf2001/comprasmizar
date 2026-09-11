import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../../app/api/health/route";

// /api/health informa el commit desplegado (build-arg APP_COMMIT, leído en ejecución). Nació de un
// día en que tres veces se pidió desplegar lo que ya corría: sin esto, "qué hay en producción" solo
// se sabía comparando mensajes entre sesiones.
const previous = process.env.APP_COMMIT;
afterEach(() => { if (previous === undefined) delete process.env.APP_COMMIT; else process.env.APP_COMMIT = previous; });

describe("/api/health informa el commit", () => {
  it("devuelve el commit cuando la build lo horneó", async () => {
    process.env.APP_COMMIT = "5e435ee0c0ffee";
    expect((await (await GET()).json()).commit).toBe("5e435ee0c0ffee");
  });

  it("devuelve null, no una cadena vacía, cuando la build no lo recibió", async () => {
    // Una imagen construida sin el build-arg debe decirlo; "" pasaría por un valor y engañaría.
    process.env.APP_COMMIT = "   ";
    expect((await (await GET()).json()).commit).toBeNull();
    delete process.env.APP_COMMIT;
    expect((await (await GET()).json()).commit).toBeNull();
  });
});
