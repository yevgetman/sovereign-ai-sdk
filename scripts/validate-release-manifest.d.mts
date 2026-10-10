export function validatePlanningRecords(manifest: unknown, plan: unknown): string[];
export function validateSourceUnits(
  manifest: unknown,
  plan: unknown,
  git: (args: string[]) => string,
): string[];
