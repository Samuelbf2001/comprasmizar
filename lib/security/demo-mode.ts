export type DemoEnv = Readonly<Record<string, string | undefined>>;

/** Demo data is an explicit opt-in. Missing, mixed-case or truthy-looking values fail closed. */
export function demoModeEnabled(source: DemoEnv = process.env): boolean {
  return source.NEXT_PUBLIC_DEMO_MODE === "true";
}
