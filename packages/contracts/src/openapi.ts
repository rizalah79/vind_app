import {
  problemCatalog,
  problemJsonContentType,
  problemTypePrefix
} from "./problem.js";

export const requestIdHeaderName = "x-request-id" as const;

const problemCodes = Object.keys(problemCatalog);
const problemTypes = problemCodes.map((code) => `${problemTypePrefix}${code}`);

export const openApiDocument = {
  openapi: "3.1.0",
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "Vind API",
    version: "0.1.0"
  },
  paths: {
    "/api/v1/health/live": {
      get: {
        operationId: "getLiveHealth",
        tags: ["Health"],
        responses: {
          "200": {
            description: "The API process is live.",
            headers: {
              "x-request-id": {
                $ref: "#/components/headers/RequestId"
              }
            },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/LiveHealthEnvelope"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/health/ready": {
      get: {
        operationId: "getReadyHealth",
        tags: ["Health"],
        responses: {
          "200": {
            description: "The API and required dependencies are ready.",
            headers: {
              "x-request-id": {
                $ref: "#/components/headers/RequestId"
              }
            },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ReadyHealthEnvelope"
                }
              }
            }
          },
          "503": {
            $ref: "#/components/responses/Problem"
          }
        }
      }
    },
    "/api/v1/openapi.json": {
      get: {
        operationId: "getOpenApiDocument",
        tags: ["OpenAPI"],
        responses: {
          "200": {
            description: "The OpenAPI 3.1 document.",
            headers: {
              "x-request-id": {
                $ref: "#/components/headers/RequestId"
              }
            },
            content: {
              "application/json": {
                schema: {
                  type: "object"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/me": {
      get: {
        operationId: "getAuthenticatedContext",
        tags: ["Session"],
        summary: "Get authenticated context and presentation details",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": {
            description: "Authenticated actor context.",
            headers: {
              "x-request-id": {
                $ref: "#/components/headers/RequestId"
              }
            },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AuthenticatedContextEnvelope"
                }
              }
            }
          },
          "401": {
            $ref: "#/components/responses/Problem"
          }
        }
      }
    },
    "/api/v1/session/logout": {
      post: {
        operationId: "logoutSession",
        tags: ["Session"],
        summary: "Revoke session and clear authentication context",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": {
            description: "Session successfully revoked.",
            headers: {
              "x-request-id": {
                $ref: "#/components/headers/RequestId"
              }
            },
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/LogoutEnvelope"
                }
              }
            }
          },
          "401": {
            $ref: "#/components/responses/Problem"
          }
        }
      }
    },
    "/api/v1/public/providers/{providerId}": {
      get: {
        operationId: "getPublicProviderProfile",
        tags: ["Public Catalog"],
        summary: "Get active public provider profile",
        parameters: [
          {
            name: "providerId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" }
          }
        ],
        responses: {
          "200": {
            description: "Active public provider profile.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublicProviderProfileEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/api/v1/public/listings": {
      get: {
        operationId: "getPublicListings",
        tags: ["Public Catalog"],
        summary: "List published channel listings with opaque cursor pagination",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
          { name: "provider_id", in: "query", schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": {
            description: "Paginated list of published channel listings.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublicListingsEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/api/v1/public/listings/{publicationId}": {
      get: {
        operationId: "getPublicListingDetail",
        tags: ["Public Catalog"],
        summary: "Get published channel listing detail",
        parameters: [
          { name: "publicationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": {
            description: "Published channel listing detail.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublicListingDetailEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/api/v1/providers/{providerId}": {
      get: {
        operationId: "getProviderProfile",
        tags: ["Provider Management"],
        summary: "Get provider profile detail for authorized tenant",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "providerId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": {
            description: "Provider profile detail.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ProviderDetailEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/api/v1/providers/{providerId}/offerings": {
      get: {
        operationId: "getProviderOfferings",
        tags: ["Catalog Management"],
        summary: "List provider offerings with pagination",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "providerId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } }
        ],
        responses: {
          "200": {
            description: "Paginated list of provider offerings.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/OfferingSummariesEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/api/v1/catalog/offerings/{offeringId}": {
      get: {
        operationId: "getOfferingDetail",
        tags: ["Catalog Management"],
        summary: "Get catalog offering detail including linked resources",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "offeringId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": {
            description: "Catalog offering detail.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/OfferingDetailEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/api/v1/catalog/packages/{packageId}": {
      get: {
        operationId: "getPackageDetail",
        tags: ["Catalog Management"],
        summary: "Get catalog package detail including items",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "packageId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": {
            description: "Catalog package detail.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PackageDetailEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/api/v1/public/media/{mediaId}/delivery": {
      get: {
        operationId: "getPublicMediaDelivery",
        tags: ["Media Delivery"],
        summary: "Get public safe media delivery URL",
        parameters: [
          { name: "mediaId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": {
            description: "Public safe media delivery metadata and short-lived URL.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/MediaDeliveryEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "503": { $ref: "#/components/responses/Problem" }
        }
      }
    },
    "/api/v1/media/{mediaId}/delivery": {
      get: {
        operationId: "getAuthenticatedMediaDelivery",
        tags: ["Media Delivery"],
        summary: "Get authenticated safe media delivery URL",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "mediaId", in: "path", required: true, schema: { type: "string", format: "uuid" } }
        ],
        responses: {
          "200": {
            description: "Authenticated safe media delivery metadata and short-lived URL.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/MediaDeliveryEnvelope" } } }
          },
          "400": { $ref: "#/components/responses/Problem" },
          "401": { $ref: "#/components/responses/Problem" },
          "404": { $ref: "#/components/responses/Problem" },
          "503": { $ref: "#/components/responses/Problem" }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "vind_session",
        description: "Server-side opaque session token stored in an HttpOnly cookie."
      }
    },
    headers: {
      RequestId: {
        description: "Request correlation identifier generated by the API or propagated from a valid x-request-id header.",
        schema: {
          $ref: "#/components/schemas/RequestId"
        }
      }
    },
    responses: {
      Problem: {
        description: "A problem response.",
        headers: {
          "x-request-id": {
            $ref: "#/components/headers/RequestId"
          }
        },
        content: {
          [problemJsonContentType]: {
            schema: {
              $ref: "#/components/schemas/ProblemDetails"
            }
          }
        }
      }
    },
    schemas: {
      RequestId: {
        type: "string",
        minLength: 8,
        maxLength: 128,
        pattern: "^[A-Za-z0-9._:-]+$"
      },
      LiveHealth: {
        type: "object",
        required: ["status"],
        properties: {
          status: {
            const: "live"
          }
        },
        additionalProperties: false
      },
      ReadyHealth: {
        type: "object",
        required: ["status"],
        properties: {
          status: {
            const: "ready"
          }
        },
        additionalProperties: false
      },
      ResponseMeta: {
        type: "object",
        required: ["request_id"],
        properties: {
          request_id: {
            $ref: "#/components/schemas/RequestId"
          }
        },
        additionalProperties: false
      },
      LiveHealthEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            $ref: "#/components/schemas/LiveHealth"
          },
          meta: {
            $ref: "#/components/schemas/ResponseMeta"
          }
        },
        additionalProperties: false
      },
      ReadyHealthEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            $ref: "#/components/schemas/ReadyHealth"
          },
          meta: {
            $ref: "#/components/schemas/ResponseMeta"
          }
        },
        additionalProperties: false
      },
      ProblemDetails: {
        type: "object",
        required: ["type", "title", "status", "code", "request_id", "retryable", "instance"],
        properties: {
          type: {
            enum: problemTypes
          },
          title: {
            type: "string"
          },
          status: {
            type: "integer",
            minimum: 400,
            maximum: 599
          },
          code: {
            enum: problemCodes
          },
          request_id: {
            $ref: "#/components/schemas/RequestId"
          },
          retryable: {
            type: "boolean"
          },
          instance: {
            type: "string"
          },
          detail: {
            type: "string"
          },
          field_errors: {
            type: "array",
            items: {
              $ref: "#/components/schemas/FieldError"
            }
          }
        },
        additionalProperties: true
      },
      FieldError: {
        type: "object",
        required: ["field", "code"],
        properties: {
          field: {
            type: "string"
          },
          code: {
            type: "string"
          },
          message: {
            type: "string"
          }
        },
        additionalProperties: false
      },
      ChannelSummary: {
        type: "object",
        required: ["code", "name"],
        properties: {
          code: { type: "string" },
          name: { type: "string" }
        },
        additionalProperties: false
      },
      AuthenticatedContext: {
        type: "object",
        required: ["actor_kind", "authority_plane", "account_key", "channel"],
        properties: {
          actor_kind: { enum: ["HUMAN", "SERVICE"] },
          authority_plane: { enum: ["RELATIONSHIP", "LOCAL", "PLATFORM", "SERVICE"] },
          account_key: { type: "string" },
          person_key: { type: "string" },
          channel: { $ref: "#/components/schemas/ChannelSummary" },
          membership_key: { type: "string" },
          local_assignment_key: { type: "string" },
          platform_assignment_key: { type: "string" },
          service_grant_key: { type: "string" },
          organization_key: { type: "string" },
          workspace_key: { type: "string" },
          provider_key: { type: "string" },
          region_key: { type: "string" }
        },
        additionalProperties: false
      },
      AuthenticatedContextEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { $ref: "#/components/schemas/AuthenticatedContext" },
          meta: { $ref: "#/components/schemas/ResponseMeta" }
        },
        additionalProperties: false
      },
      LogoutResult: {
        type: "object",
        required: ["success"],
        properties: {
          success: { type: "boolean" }
        },
        additionalProperties: false
      },
      LogoutEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { $ref: "#/components/schemas/LogoutResult" },
          meta: { $ref: "#/components/schemas/ResponseMeta" }
        },
        additionalProperties: false
      },
      PaginationMeta: {
        type: "object",
        required: ["next_cursor", "has_more"],
        properties: {
          next_cursor: { type: ["string", "null"] },
          has_more: { type: "boolean" }
        },
        additionalProperties: false
      },
      PublicProviderProfile: {
        type: "object",
        required: ["id", "display_name", "provider_type", "status", "created_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          display_name: { type: "string" },
          provider_type: { type: "string" },
          status: { type: "string" },
          created_at: { type: "string" }
        },
        additionalProperties: false
      },
      PublicProviderProfileEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { $ref: "#/components/schemas/PublicProviderProfile" },
          meta: { $ref: "#/components/schemas/ResponseMeta" }
        },
        additionalProperties: false
      },
      PublicListingSummary: {
        type: "object",
        required: ["id", "provider_id", "offering_id", "package_id", "channel_code", "publication_status", "title", "description", "effective_from", "created_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          provider_id: { type: "string", format: "uuid" },
          offering_id: { type: ["string", "null"], format: "uuid" },
          package_id: { type: ["string", "null"], format: "uuid" },
          channel_code: { type: "string" },
          publication_status: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          effective_from: { type: ["string", "null"] },
          created_at: { type: "string" }
        },
        additionalProperties: false
      },
      PublicListingsEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/PublicListingSummary" }
          },
          meta: {
            type: "object",
            required: ["request_id", "pagination"],
            properties: {
              request_id: { $ref: "#/components/schemas/RequestId" },
              pagination: { $ref: "#/components/schemas/PaginationMeta" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      PublicListingDetail: {
        type: "object",
        required: ["id", "provider_id", "provider", "offering_id", "offering", "package_id", "package", "channel_code", "publication_status", "effective_from", "created_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          provider_id: { type: "string", format: "uuid" },
          provider: {
            type: "object",
            required: ["id", "display_name", "provider_type"],
            properties: {
              id: { type: "string", format: "uuid" },
              display_name: { type: "string" },
              provider_type: { type: "string" }
            },
            additionalProperties: false
          },
          offering_id: { type: ["string", "null"], format: "uuid" },
          offering: {
            type: ["object", "null"],
            required: ["id", "offering_code", "title", "description"],
            properties: {
              id: { type: "string", format: "uuid" },
              offering_code: { type: "string" },
              title: { type: "string" },
              description: { type: ["string", "null"] }
            },
            additionalProperties: false
          },
          package_id: { type: ["string", "null"], format: "uuid" },
          package: {
            type: ["object", "null"],
            required: ["id", "package_code", "title", "anchor_offering_id"],
            properties: {
              id: { type: "string", format: "uuid" },
              package_code: { type: "string" },
              title: { type: "string" },
              anchor_offering_id: { type: "string", format: "uuid" }
            },
            additionalProperties: false
          },
          channel_code: { type: "string" },
          publication_status: { type: "string" },
          effective_from: { type: ["string", "null"] },
          created_at: { type: "string" }
        },
        additionalProperties: false
      },
      PublicListingDetailEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { $ref: "#/components/schemas/PublicListingDetail" },
          meta: { $ref: "#/components/schemas/ResponseMeta" }
        },
        additionalProperties: false
      },
      ProviderDetail: {
        type: "object",
        required: ["id", "display_name", "legal_name", "provider_type", "status", "owning_organization_id", "owning_person_id", "created_at", "updated_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          display_name: { type: "string" },
          legal_name: { type: "string" },
          provider_type: { type: "string" },
          status: { type: "string" },
          owning_organization_id: { type: ["string", "null"], format: "uuid" },
          owning_person_id: { type: ["string", "null"], format: "uuid" },
          created_at: { type: "string" },
          updated_at: { type: "string" }
        },
        additionalProperties: false
      },
      ProviderDetailEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { $ref: "#/components/schemas/ProviderDetail" },
          meta: { $ref: "#/components/schemas/ResponseMeta" }
        },
        additionalProperties: false
      },
      OfferingSummary: {
        type: "object",
        required: ["id", "provider_profile_id", "offering_code", "title", "description", "status", "created_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          provider_profile_id: { type: "string", format: "uuid" },
          offering_code: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          status: { type: "string" },
          created_at: { type: "string" }
        },
        additionalProperties: false
      },
      OfferingSummariesEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/OfferingSummary" }
          },
          meta: {
            type: "object",
            required: ["request_id", "pagination"],
            properties: {
              request_id: { $ref: "#/components/schemas/RequestId" },
              pagination: { $ref: "#/components/schemas/PaginationMeta" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      OfferingDetail: {
        type: "object",
        required: ["id", "provider_profile_id", "offering_code", "title", "description", "status", "resources", "created_at", "updated_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          provider_profile_id: { type: "string", format: "uuid" },
          offering_code: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          status: { type: "string" },
          resources: {
            type: "array",
            items: {
              type: "object",
              required: ["resource_id", "resource_code", "title", "resource_type", "quantity"],
              properties: {
                resource_id: { type: "string", format: "uuid" },
                resource_code: { type: "string" },
                title: { type: "string" },
                resource_type: { type: "string" },
                quantity: { type: "integer" }
              },
              additionalProperties: false
            }
          },
          created_at: { type: "string" },
          updated_at: { type: "string" }
        },
        additionalProperties: false
      },
      OfferingDetailEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { $ref: "#/components/schemas/OfferingDetail" },
          meta: { $ref: "#/components/schemas/ResponseMeta" }
        },
        additionalProperties: false
      },
      PackageDetail: {
        type: "object",
        required: ["id", "provider_profile_id", "package_code", "title", "anchor_offering_id", "status", "items", "created_at", "updated_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          provider_profile_id: { type: "string", format: "uuid" },
          package_code: { type: "string" },
          title: { type: "string" },
          anchor_offering_id: { type: "string", format: "uuid" },
          status: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["offering_id", "offering_code", "title", "quantity", "is_optional"],
              properties: {
                offering_id: { type: "string", format: "uuid" },
                offering_code: { type: "string" },
                title: { type: "string" },
                quantity: { type: "integer" },
                is_optional: { type: "boolean" }
              },
              additionalProperties: false
            }
          },
          created_at: { type: "string" },
          updated_at: { type: "string" }
        },
        additionalProperties: false
      },
      PackageDetailEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { $ref: "#/components/schemas/PackageDetail" },
          meta: { $ref: "#/components/schemas/ResponseMeta" }
        },
        additionalProperties: false
      },
      MediaDelivery: {
        type: "object",
        required: [
          "media_id",
          "content_type",
          "file_name",
          "file_size_bytes",
          "checksum_sha256",
          "delivery_url",
          "expires_at"
        ],
        properties: {
          media_id: { type: "string", format: "uuid" },
          content_type: { type: "string" },
          file_name: { type: "string" },
          file_size_bytes: { type: "integer" },
          checksum_sha256: { type: "string" },
          delivery_url: { type: "string" },
          expires_at: { type: "string" }
        },
        additionalProperties: false
      },
      MediaDeliveryEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { $ref: "#/components/schemas/MediaDelivery" },
          meta: { $ref: "#/components/schemas/ResponseMeta" }
        },
        additionalProperties: false
      }
    }
  }
} as const;

export type OpenApiDocument = typeof openApiDocument;
