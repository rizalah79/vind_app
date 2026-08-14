export const problemJsonContentType = "application/problem+json" as const;
export const problemTypePrefix = "urn:vind:error:" as const;

export const problemCatalog = {
  VALIDATION_FAILED: {
    status: 400,
    title: "Validation Failed",
    retryable: false
  },
  AUTHENTICATION_REQUIRED: {
    status: 401,
    title: "Authentication Required",
    retryable: false
  },
  AUTH_ASSURANCE_REQUIRED: {
    status: 401,
    title: "Auth Assurance Required",
    retryable: false
  },
  CAPABILITY_DENIED: {
    status: 403,
    title: "Capability Denied",
    retryable: false
  },
  OBJECT_ACCESS_DENIED: {
    status: 403,
    title: "Object Access Denied",
    retryable: false
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    title: "Resource Not Found",
    retryable: false
  },
  STATE_CONFLICT: {
    status: 409,
    title: "State Conflict",
    retryable: false
  },
  PRECONDITION_FAILED: {
    status: 412,
    title: "Precondition Failed",
    retryable: false
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    title: "Idempotency Conflict",
    retryable: false
  },
  RATE_LIMITED: {
    status: 429,
    title: "Rate Limited",
    retryable: true
  },
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    title: "Dependency Unavailable",
    retryable: true
  },
  INTERNAL_ERROR: {
    status: 500,
    title: "Internal Error",
    retryable: false
  }
} as const;

export type ProblemCode = keyof typeof problemCatalog;

export interface FieldError {
  field: string;
  code: string;
  message?: string;
}

export interface ProblemDetails {
  type: `${typeof problemTypePrefix}${ProblemCode}`;
  title: string;
  status: number;
  code: ProblemCode;
  request_id: string;
  retryable: boolean;
  instance: string;
  detail?: string;
  field_errors?: FieldError[];
  [extension: string]: unknown;
}

export interface ProblemDetailsInput {
  code: ProblemCode;
  requestId: string;
  instance: string;
  detail?: string;
  fieldErrors?: FieldError[];
  extensions?: Record<string, unknown>;
}

export function createProblemDetails(input: ProblemDetailsInput): ProblemDetails {
  const catalogItem = problemCatalog[input.code];
  const problem: ProblemDetails = {
    type: `${problemTypePrefix}${input.code}` as ProblemDetails["type"],
    title: catalogItem.title,
    status: catalogItem.status,
    code: input.code,
    request_id: input.requestId,
    retryable: catalogItem.retryable,
    instance: input.instance
  };

  if (input.detail !== undefined) {
    problem.detail = input.detail;
  }

  if (input.fieldErrors !== undefined) {
    problem.field_errors = input.fieldErrors;
  }

  if (input.extensions !== undefined) {
    Object.assign(problem, input.extensions);
  }

  return problem;
}
