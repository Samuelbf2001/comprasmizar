import { describe, expect, it } from "vitest";
import { demoModeEnabled } from "../../lib/security/demo-mode";

describe("demo mode gate", () => {
  it("requires the exact explicit opt-in and otherwise fails closed", () => {
    expect(demoModeEnabled({ NEXT_PUBLIC_DEMO_MODE: "true" })).toBe(true);
    expect(demoModeEnabled({ NEXT_PUBLIC_DEMO_MODE: "TRUE" })).toBe(false);
    expect(demoModeEnabled({ NEXT_PUBLIC_DEMO_MODE: "1" })).toBe(false);
    expect(demoModeEnabled({})).toBe(false);
  });
});
