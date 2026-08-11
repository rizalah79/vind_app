import { randomUUID } from "node:crypto";

export const requestIdHeaderName = "x-request-id" as const;
export const requestIdPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export type RequestIdResolution =
  | {
      ok: true;
      requestId: string;
    }
  | {
      ok: false;
      requestId: string;
      reason: "invalid_format" | "multiple_values";
    };

export function generateRequestId(): string {
  return randomUUID();
}

export function isValidRequestId(value: string): boolean {
  return requestIdPattern.test(value);
}

export function resolveRequestIdHeader(
  value: string | string[] | undefined
): RequestIdResolution {
  if (value === undefined) {
    return {
      ok: true,
      requestId: generateRequestId()
    };
  }

  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return {
        ok: false,
        requestId: generateRequestId(),
        reason: "multiple_values"
      };
    }

    return resolveRequestIdHeader(value[0]);
  }

  if (!isValidRequestId(value)) {
    return {
      ok: false,
      requestId: generateRequestId(),
      reason: "invalid_format"
    };
  }

  return {
    ok: true,
    requestId: value
  };
}
