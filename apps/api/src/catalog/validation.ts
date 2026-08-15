import { HttpProblemError } from "../errors.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_REGEX.test(id);
}

export function validateUuid(id: unknown, fieldName: string = "identifier"): string {
  if (!isValidUuid(id)) {
    throw new HttpProblemError({
      code: "VALIDATION_FAILED",
      detail: `Invalid UUID format for ${fieldName}.`
    });
  }
  return id;
}

export function validateLimit(limitStr: string | undefined): number {
  if (limitStr === undefined) {
    return 10;
  }
  if (!/^\d+$/.test(limitStr)) {
    throw new HttpProblemError({
      code: "VALIDATION_FAILED",
      detail: "Limit parameter must be an integer between 1 and 50."
    });
  }
  const limitNum = Number.parseInt(limitStr, 10);
  if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 50) {
    throw new HttpProblemError({
      code: "VALIDATION_FAILED",
      detail: "Limit parameter must be an integer between 1 and 50."
    });
  }
  return limitNum;
}
