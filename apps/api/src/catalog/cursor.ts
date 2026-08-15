import { HttpProblemError } from "../errors.js";
import { isValidUuid } from "./validation.js";

export interface CursorPayload {
  createdAt: string;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  const jsonStr = JSON.stringify({ c: payload.createdAt, i: payload.id });
  return Buffer.from(jsonStr, "utf-8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const jsonStr = Buffer.from(cursor, "base64url").toString("utf-8");
    const parsed = JSON.parse(jsonStr);
    if (
      parsed &&
      typeof parsed.c === "string" &&
      !Number.isNaN(Date.parse(parsed.c)) &&
      isValidUuid(parsed.i)
    ) {
      return { createdAt: parsed.c, id: parsed.i };
    }
  } catch {
    // throw below
  }

  throw new HttpProblemError({
    code: "VALIDATION_FAILED",
    detail: "Malformed or invalid cursor payload."
  });
}
