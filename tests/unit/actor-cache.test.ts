import { describe, expect, it } from "vitest";
import { getCachedProfile, invalidateActorCache, setCachedProfile, type ActorProfile } from "../../lib/infrastructure/actor-cache";

// H1 (docs/plan-rendimiento.md): caché en proceso del perfil de usuarios.usuarios, con TTL de 60 s y
// tamaño máximo 500 (evicción del más antiguo). El `clock` inyectable evita depender de temporizadores
// reales o de `vi.useFakeTimers()` (que también congelaría el pool de `postgres`) — un contador simple
// basta para controlar el paso del tiempo de forma determinística.
function fakeClock(startMs = 0) { let now = startMs; return { now: () => now, advance: (ms: number) => { now += ms; } }; }
const profile = (suffix: string): ActorProfile => ({ estado: "activo", nombre: `Nombre ${suffix}`, email: `${suffix}@mizar.test`, roles: ["revisor"] });

describe("actor-cache — caché en proceso del perfil de actor (H1)", () => {
  it("getCachedProfile devuelve undefined si nunca se guardó nada para ese id", () => {
    expect(getCachedProfile("nunca-guardado", fakeClock().now)).toBeUndefined();
  });

  it("setCachedProfile + getCachedProfile dentro del TTL devuelven el mismo perfil", () => {
    const clock = fakeClock(1_000);
    setCachedProfile("u1", profile("u1"), clock.now);
    clock.advance(59_000); // 59 s < 60 s de TTL
    expect(getCachedProfile("u1", clock.now)).toEqual(profile("u1"));
  });

  it("expira exactamente al cumplirse el TTL de 60 s (clock falso, sin temporizadores reales)", () => {
    const clock = fakeClock(0);
    setCachedProfile("u2", profile("u2"), clock.now);
    clock.advance(59_999);
    expect(getCachedProfile("u2", clock.now)).toEqual(profile("u2"));
    clock.advance(1); // ahora exactamente 60_000 ms después
    expect(getCachedProfile("u2", clock.now)).toBeUndefined();
  });

  it("invalidateActorCache(userId) solo borra esa cuenta; sin argumento borra todo", () => {
    const clock = fakeClock(0);
    setCachedProfile("a", profile("a"), clock.now);
    setCachedProfile("b", profile("b"), clock.now);
    invalidateActorCache("a");
    expect(getCachedProfile("a", clock.now)).toBeUndefined();
    expect(getCachedProfile("b", clock.now)).toEqual(profile("b"));
    invalidateActorCache();
    expect(getCachedProfile("b", clock.now)).toBeUndefined();
  });

  it("al superar 500 entradas evita crecer sin límite descartando la más antigua", () => {
    invalidateActorCache();
    const clock = fakeClock(0);
    for (let index = 0; index < 500; index++) setCachedProfile(`user-${index}`, profile(String(index)), clock.now);
    expect(getCachedProfile("user-0", clock.now)).toEqual(profile("0"));
    setCachedProfile("user-500", profile("500"), clock.now); // entrada 501: debe desalojar la más vieja (user-0)
    expect(getCachedProfile("user-0", clock.now)).toBeUndefined();
    expect(getCachedProfile("user-500", clock.now)).toEqual(profile("500"));
    expect(getCachedProfile("user-1", clock.now)).toEqual(profile("1")); // el resto sigue intacto
  });
});
