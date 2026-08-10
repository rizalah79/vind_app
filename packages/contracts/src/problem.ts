export const problemJsonContentType = "application/problem+json" as const;
export const problemTypeBaseUrl = "https://api.vind.app/problems" as const;

export const problemCatalog = {
  bad_request: {
    status: 400,
    title: "Bad Request"
  },
  invalid_request_id: {
    status: 400,
    title: "Invalid Request ID"
  },
  not_found: {
    status: 404,
    title: "Not Found"
  },
  service_unavailable: {
    status: 503,
    title: "Service Unavailable"
  },
  internal_error: {
    status: 500,
    title: "Internal Server Error"
  }
} as const;

export type ProblemCode = keyof typeof problemCatalog;

export interface ProblemDetails {
  type: `${typeof problemTypeBaseUrl}/${ProblemCode}`;
  title: string;
  status: number;
  code: ProblemCode;
  requestId: string;
  instance: string;
  detail?: string;
  [extension: string]: unknown;
}

export interface ProblemDetailsInput {
  code: ProblemCode;
  requestId: string;
  instance: string;
  detail?: string;
  extensions?: Record<string, unknown>;
}

export function createProblemDetails(input: ProblemDetailsInput): ProblemDetails {
  const catalogItem = problemCatalog[input.code];
  const problem: ProblemDetails = {
    type: `${problemTypeBaseUrl}/${input.code}` as ProblemDetails["type"],
    title: catalogItem.title,
    status: catalogItem.status,
    code: input.code,
    requestId: input.requestId,
    instance: input.instance
  };

  if (input.detail !== undefined) {
    problem.detail = input.detail;
  }

  if (input.extensions !== undefined) {
    Object.assign(problem, input.extensions);
  }

  return problem;
}
