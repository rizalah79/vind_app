import {
  createProblemDetails,
  problemJsonContentType,
  type FieldError,
  type ProblemCode,
  type ProblemDetails
} from "@vind/contracts";

export class HttpProblemError extends Error {
  readonly code: ProblemCode;
  readonly safeDetail: string | undefined;
  readonly fieldErrors: FieldError[] | undefined;
  readonly extensions: Record<string, unknown> | undefined;

  constructor(input: {
    code: ProblemCode;
    detail?: string;
    fieldErrors?: FieldError[];
    extensions?: Record<string, unknown>;
  }) {
    super(input.detail ?? input.code);
    this.name = "HttpProblemError";
    this.code = input.code;
    this.safeDetail = input.detail;
    this.fieldErrors = input.fieldErrors;
    this.extensions = input.extensions;
  }
}

export function createHttpProblem(input: {
  error: unknown;
  requestId: string;
  instance: string;
}): ProblemDetails {
  if (input.error instanceof HttpProblemError) {
    const problemInput = {
      code: input.error.code,
      requestId: input.requestId,
      instance: input.instance
    };

    return createProblemDetails({
      ...problemInput,
      ...(input.error.safeDetail === undefined
        ? {}
        : { detail: input.error.safeDetail }),
      ...(input.error.fieldErrors === undefined
        ? {}
        : { fieldErrors: input.error.fieldErrors }),
      ...(input.error.extensions === undefined
        ? {}
        : { extensions: input.error.extensions })
    });
  }

  return createProblemDetails({
    code: "INTERNAL_ERROR",
    requestId: input.requestId,
    instance: input.instance,
    detail: "An unexpected error occurred."
  });
}

export { problemJsonContentType };
