export interface CursorPayload {
  createdAt: string;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  const jsonStr = JSON.stringify({ c: payload.createdAt, i: payload.id });
  return Buffer.from(jsonStr, "utf-8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const jsonStr = Buffer.from(cursor, "base64url").toString("utf-8");
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed.c === "string" && typeof parsed.i === "string") {
      return { createdAt: parsed.c, id: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}
