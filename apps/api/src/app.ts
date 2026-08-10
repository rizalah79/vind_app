import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import {
  openApiDocument,
  requestIdHeaderName
} from "@vind/contracts";
import {
  HttpProblemError,
  createHttpProblem,
  problemJsonContentType
} from "./errors.js";
import {
  checkReadiness,
  createDatabaseReadinessDependency,
  type ReadinessDependency
} from "./readiness.js";
import {
  generateRequestId,
  resolveRequestIdHeader
} from "./request-id.js";

declare module "fastify" {
  interface FastifyRequest {
    vindRequestId: string;
  }
}

export interface BuildAppOptions {
  readinessDependencies?: readonly ReadinessDependency[];
}

function getProblemInstance(request: FastifyRequest): string {
  return request.url;
}

function getRequestId(request: FastifyRequest): string {
  return request.vindRequestId || request.id;
}

function sendProblem(
  reply: FastifyReply,
  problem: ReturnType<typeof createHttpProblem>
): void {
  reply
    .status(problem.status)
    .type(problemJsonContentType)
    .send(problem);
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    genReqId: generateRequestId
  });
  const readinessDependencies =
    options.readinessDependencies ?? [createDatabaseReadinessDependency()];

  app.decorateRequest("vindRequestId", "");

  app.addHook("onRequest", async (request, reply) => {
    const resolution = resolveRequestIdHeader(
      request.headers[requestIdHeaderName]
    );
    request.vindRequestId = resolution.requestId;
    reply.header(requestIdHeaderName, resolution.requestId);

    if (!resolution.ok) {
      throw new HttpProblemError({
        code: "invalid_request_id",
        detail: "x-request-id must be 8-128 characters using letters, numbers, '.', '_', ':', or '-'."
      });
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(requestIdHeaderName, getRequestId(request));
    return payload;
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = createHttpProblem({
      error: new HttpProblemError({
        code: "not_found",
        detail: "The requested resource was not found."
      }),
      requestId: getRequestId(request),
      instance: getProblemInstance(request)
    });
    sendProblem(reply, problem);
  });

  app.setErrorHandler((error, request, reply) => {
    const problem = createHttpProblem({
      error,
      requestId: getRequestId(request),
      instance: getProblemInstance(request)
    });
    sendProblem(reply, problem);
  });

  app.get("/api/v1/health/live", async () => ({
    status: "live"
  }));

  app.get("/api/v1/health/ready", async () => {
    const readiness = await checkReadiness(readinessDependencies);

    if (!readiness.ready) {
      throw new HttpProblemError({
        code: "service_unavailable",
        detail: "One or more dependencies are not ready.",
        extensions: {
          dependencies: readiness.dependencies
        }
      });
    }

    return {
      status: "ready",
      dependencies: readiness.dependencies
    };
  });

  app.get("/api/v1/openapi.json", async () => openApiDocument);

  return app;
}
