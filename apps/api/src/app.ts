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
import { registerAuthRoutes } from "./auth/auth-routes.js";
import { type SessionStore } from "./auth/session.js";
import { type ChannelHostConfig } from "./auth/channel.js";

import { type DatabaseClient } from "@vind/database";
import { registerPublicCatalogRoutes } from "./catalog/public-catalog-routes.js";
import { registerAuthenticatedCatalogRoutes } from "./catalog/authenticated-catalog-routes.js";

declare module "fastify" {
  interface FastifyRequest {
    vindRequestId: string;
  }
}

export interface BuildAppOptions {
  readinessDependencies?: readonly ReadinessDependency[];
  sessionStore?: SessionStore | undefined;
  channelHostConfig?: ChannelHostConfig | undefined;
  domainDbClient?: DatabaseClient | undefined;
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

function createEnvelope<TData>(
  data: TData,
  requestId: string
): { data: TData; meta: { request_id: string } } {
  return {
    data,
    meta: {
      request_id: requestId
    }
  };
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
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(requestIdHeaderName, getRequestId(request));
    return payload;
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = createHttpProblem({
      error: new HttpProblemError({
        code: "RESOURCE_NOT_FOUND",
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

  app.get("/api/v1/health/live", async (request) => ({
    ...createEnvelope({
      status: "live"
    }, getRequestId(request))
  }));

  app.get("/api/v1/health/ready", async (request) => {
    const readiness = await checkReadiness(readinessDependencies);

    if (!readiness.ready) {
      throw new HttpProblemError({
        code: "DEPENDENCY_UNAVAILABLE",
        detail: "A required dependency is unavailable."
      });
    }

    return createEnvelope({
      status: "ready"
    }, getRequestId(request));
  });

  app.get("/api/v1/openapi.json", async () => openApiDocument);

  if (options.sessionStore && options.channelHostConfig) {
    registerAuthRoutes(app, {
      sessionStore: options.sessionStore,
      channelHostConfig: options.channelHostConfig
    });
  } else if (options.sessionStore || options.channelHostConfig) {
    throw new Error("Both sessionStore and channelHostConfig must be supplied together to enable auth routes.");
  }

  if (options.channelHostConfig && options.domainDbClient) {
    registerPublicCatalogRoutes(app, {
      dbClient: options.domainDbClient,
      channelHostConfig: options.channelHostConfig
    });
  }

  if (options.sessionStore && options.channelHostConfig && options.domainDbClient) {
    registerAuthenticatedCatalogRoutes(app, {
      dbClient: options.domainDbClient,
      sessionStore: options.sessionStore,
      channelHostConfig: options.channelHostConfig
    });
  }

  return app;
}
