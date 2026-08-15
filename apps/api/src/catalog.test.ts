import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import type { SessionStore, ResolvedSessionContext } from "./auth/session.js";
import type { DatabaseClient } from "@vind/database";

class TestInMemorySessionStore implements SessionStore {
  private sessions = new Map<string, ResolvedSessionContext>();

  addSession(rawToken: string, session: ResolvedSessionContext): void {
    this.sessions.set(rawToken, session);
  }

  async resolveSession(rawToken: string): Promise<ResolvedSessionContext | null> {
    const session = this.sessions.get(rawToken);
    if (!session) return null;
    if (session.absoluteExpiresAt.getTime() <= Date.now()) return null;
    return session;
  }

  async revokeSession(rawToken: string, _reasonCode?: string): Promise<boolean> {
    const existed = this.sessions.has(rawToken);
    this.sessions.delete(rawToken);
    return existed;
  }
}

describe("B3 — Provider, Catalog, and Listing Read APIs", () => {
  const channelHostConfig = {
    vindzamAllowedHosts: ["vindzam.test", "localhost"],
    vindlokaAllowedHosts: ["vindloka.test"]
  };

  const mockProviderActive = {
    id: "00000000-0000-4000-a000-000000000001",
    seed_key: "seed_prov_1",
    owning_organization_id: "00000000-0000-4000-a000-000000000010",
    owning_person_id: null,
    provider_type: "COMPANY",
    status: "ACTIVE",
    legal_name: "Pt Vindzam Technology Legal",
    display_name: "Vindzam Digital Services",
    retention_class_code: "OPS",
    created_at: new Date("2026-08-01T10:00:00.000Z"),
    updated_at: new Date("2026-08-01T10:00:00.000Z")
  };

  const mockProviderDraft = {
    ...mockProviderActive,
    id: "00000000-0000-4000-a000-000000000002",
    display_name: "Draft Provider",
    status: "DRAFT"
  };

  const mockOffering1 = {
    id: "00000000-0000-4000-a000-000000000101",
    seed_key: "seed_offering_1",
    provider_profile_id: mockProviderActive.id,
    offering_code: "OFF-001",
    title: "Premium Logistics Delivery",
    description: "Same day courier delivery",
    status: "ACTIVE",
    created_at: new Date("2026-08-05T10:00:00.000Z"),
    updated_at: new Date("2026-08-05T10:00:00.000Z"),
    offering_resources: [
      {
        quantity: 2,
        resources: {
          id: "00000000-0000-4000-a000-000000000201",
          resource_code: "RES-001",
          title: "Courier Vehicle Unit",
          resource_type: "VEHICLE"
        }
      }
    ]
  };

  const mockPackage1 = {
    id: "00000000-0000-4000-a000-000000000301",
    seed_key: "seed_package_1",
    provider_profile_id: mockProviderActive.id,
    package_code: "PKG-001",
    title: "Complete Enterprise Logistics Bundle",
    anchor_offering_id: mockOffering1.id,
    status: "ACTIVE",
    created_at: new Date("2026-08-06T10:00:00.000Z"),
    updated_at: new Date("2026-08-06T10:00:00.000Z"),
    package_items: [
      {
        quantity: 1,
        is_optional: false,
        offerings: {
          id: mockOffering1.id,
          offering_code: mockOffering1.offering_code,
          title: mockOffering1.title
        }
      }
    ]
  };

  const mockPublication1 = {
    id: "00000000-0000-4000-a000-000000000401",
    seed_key: "seed_pub_1",
    provider_profile_id: mockProviderActive.id,
    offering_id: mockOffering1.id,
    package_id: null,
    channel_id: "00000000-0000-4000-a000-000000000099",
    channel_code: "VINDZAM",
    publication_status: "PUBLISHED",
    effective_from: new Date("2026-08-01T00:00:00.000Z"),
    effective_to: null,
    created_at: new Date("2026-08-10T12:00:00.000Z"),
    updated_at: new Date("2026-08-10T12:00:00.000Z"),
    provider_profiles: mockProviderActive,
    offerings: {
      id: mockOffering1.id,
      offering_code: mockOffering1.offering_code,
      title: mockOffering1.title,
      description: mockOffering1.description
    },
    packages: null
  };

  function createMockDb(): DatabaseClient {
    return {
      async $queryRaw(queryStrArr: any, ...values: any[]) {
        const queryText = Array.isArray(queryStrArr) ? queryStrArr.join("?") : String(queryStrArr);

        if (queryText.includes("read_public_provider")) {
          const providerId = values[0];
          if (providerId === mockProviderActive.id) {
            return [
              {
                provider_id: mockProviderActive.id,
                display_name: mockProviderActive.display_name,
                provider_type: mockProviderActive.provider_type,
                status: mockProviderActive.status,
                created_at: mockProviderActive.created_at
              }
            ];
          }
          return [];
        }

        if (queryText.includes("read_public_listings")) {
          return [
            {
              publication_id: mockPublication1.id,
              provider_id: mockProviderActive.id,
              offering_id: mockOffering1.id,
              package_id: null,
              channel_code: "VINDZAM",
              publication_status: "PUBLISHED",
              title: mockOffering1.title,
              description: mockOffering1.description,
              effective_from: mockPublication1.effective_from,
              created_at: mockPublication1.created_at
            }
          ];
        }

        if (queryText.includes("read_public_listing")) {
          const pubId = values[0];
          if (pubId === mockPublication1.id) {
            return [
              {
                publication_id: mockPublication1.id,
                provider_id: mockProviderActive.id,
                provider_display_name: mockProviderActive.display_name,
                provider_type: mockProviderActive.provider_type,
                offering_id: mockOffering1.id,
                offering_code: mockOffering1.offering_code,
                offering_title: mockOffering1.title,
                offering_description: mockOffering1.description,
                package_id: null,
                package_code: null,
                package_title: null,
                package_anchor_offering_id: null,
                channel_code: "VINDZAM",
                publication_status: "PUBLISHED",
                effective_from: mockPublication1.effective_from,
                created_at: mockPublication1.created_at
              }
            ];
          }
          return [];
        }

        return [];
      },
      provider_profiles: {
        async findFirst({ where }: any) {
          if (where?.id === mockProviderActive.id) {
            if (where.status && where.status !== mockProviderActive.status) return null;
            return mockProviderActive;
          }
          if (where?.id === mockProviderDraft.id) {
            if (where.status && where.status !== mockProviderDraft.status) return null;
            return mockProviderDraft;
          }
          return null;
        }
      },
      channel_publications: {
        async findMany({ where }: any) {
          if (where?.publication_status === "PUBLISHED" && where?.channel_code === "VINDZAM") {
            return [mockPublication1];
          }
          return [];
        },
        async findFirst({ where }: any) {
          if (where?.id === mockPublication1.id && where?.channel_code === "VINDZAM" && where?.publication_status === "PUBLISHED") {
            return mockPublication1;
          }
          return null;
        }
      },
      offerings: {
        async findMany({ where }: any) {
          if (where?.provider_profile_id === mockProviderActive.id) {
            return [mockOffering1];
          }
          return [];
        },
        async findFirst({ where }: any) {
          if (where?.id === mockOffering1.id) {
            return mockOffering1;
          }
          return null;
        }
      },
      packages: {
        async findFirst({ where }: any) {
          if (where?.id === mockPackage1.id) {
            return mockPackage1;
          }
          return null;
        }
      },
      async $transaction(fn: any) {
        return fn({
          $executeRawUnsafe: async () => {},
          provider_profiles: {
            async findFirst({ where }: any) {
              if (where?.id === mockProviderActive.id) return mockProviderActive;
              return null;
            }
          },
          offerings: {
            async findMany({ where }: any) {
              if (where?.provider_profile_id === mockProviderActive.id) return [mockOffering1];
              return [];
            },
            async findFirst({ where }: any) {
              if (where?.id === mockOffering1.id) return mockOffering1;
              return null;
            }
          },
          packages: {
            async findFirst({ where }: any) {
              if (where?.id === mockPackage1.id) return mockPackage1;
              return null;
            }
          }
        });
      }
    } as unknown as DatabaseClient;
  }

  describe("Public Endpoints", () => {
    const mockDb = createMockDb();
    const sessionStore = new TestInMemorySessionStore();
    const app = buildApp({
      sessionStore,
      channelHostConfig,
      domainDbClient: mockDb
    });

    it("GET /api/v1/public/providers/:providerId returns 200 OK with PublicProviderProfile DTO for ACTIVE provider", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/providers/${mockProviderActive.id}`
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, mockProviderActive.id);
      assert.equal(body.data.display_name, "Vindzam Digital Services");
      assert.equal(body.data.provider_type, "COMPANY");
      assert.equal(body.data.status, "ACTIVE");
      assert.equal(body.data.created_at, mockProviderActive.created_at.toISOString());
      assert.equal(body.data.seed_key, undefined);
      assert.equal(body.data.owning_organization_id, undefined);
      assert.equal(body.data.owning_person_id, undefined);
      assert.equal(body.data.retention_class_code, undefined);
    });

    it("GET /api/v1/public/providers/:providerId returns 404 RESOURCE_NOT_FOUND for DRAFT or non-active provider", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/providers/${mockProviderDraft.id}`
      });

      assert.equal(response.statusCode, 404);
      const body = response.json();
      assert.equal(body.code, "RESOURCE_NOT_FOUND");
    });

    it("GET /api/v1/public/providers/:providerId returns 400 VALIDATION_FAILED for invalid UUID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/providers/not-a-uuid"
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });

    it("GET /api/v1/public/listings returns 200 OK with published channel listings for matched host", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/listings",
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(Array.isArray(body.data), true);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].id, mockPublication1.id);
      assert.equal(body.data[0].provider_id, mockProviderActive.id);
      assert.equal(body.data[0].channel_code, "VINDZAM");
      assert.equal(body.data[0].publication_status, "PUBLISHED");
      assert.equal(body.data[0].title, "Premium Logistics Delivery");
      assert.equal(body.meta.pagination.has_more, false);
    });

    it("GET /api/v1/public/listings returns 400 VALIDATION_FAILED for invalid provider_id filter", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/listings?provider_id=invalid-uuid",
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });

    it("GET /api/v1/public/listings returns 400 VALIDATION_FAILED for invalid limit parameter", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/listings?limit=invalid",
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });

    it("GET /api/v1/public/listings returns 400 VALIDATION_FAILED for malformed cursor payload", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/listings?cursor=malformed_cursor_payload",
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });

    it("GET /api/v1/public/listings/:publicationId returns 200 OK with listing detail", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/listings/${mockPublication1.id}`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, mockPublication1.id);
      assert.equal(body.data.provider.display_name, "Vindzam Digital Services");
      assert.equal(body.data.offering.offering_code, "OFF-001");
    });

    it("GET /api/v1/public/listings/:publicationId returns 404 for non-existent listing", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/listings/00000000-0000-4000-a000-000000000999",
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.json().code, "RESOURCE_NOT_FOUND");
    });

    it("GET /api/v1/public/listings/:publicationId returns 400 for invalid publicationId UUID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/listings/invalid-pub-id",
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });
  });

  describe("Authenticated Endpoints", () => {
    const sessionStore = new TestInMemorySessionStore();
    sessionStore.addSession("valid_human_token", {
      sessionId: "sess_123",
      actorKind: "HUMAN",
      authorityPlane: "LOCAL",
      accountKey: "acc_human_123",
      personKey: "per_human_123",
      membershipKey: "mem_123",
      localAssignmentKey: "asg_local_123",
      organizationKey: "org_123",
      providerKey: mockProviderActive.id,
      authAssuranceLevel: "AL1",
      stepUpVerified: false,
      absoluteExpiresAt: new Date(Date.now() + 86400000)
    });

    const mockDb = createMockDb();
    const app = buildApp({
      sessionStore,
      channelHostConfig,
      domainDbClient: mockDb
    });

    it("GET /api/v1/providers/:providerId returns 401 AUTHENTICATION_REQUIRED when unauthenticated", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${mockProviderActive.id}`
      });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().code, "AUTHENTICATION_REQUIRED");
    });

    it("GET /api/v1/providers/:providerId returns 400 VALIDATION_FAILED for malformed providerId", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/providers/invalid-provider-id",
        headers: {
          host: "vindzam.test",
          cookie: "vind_session=valid_human_token"
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });

    it("GET /api/v1/providers/:providerId returns 200 OK with ProviderDetail DTO for valid session", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${mockProviderActive.id}`,
        headers: {
          host: "vindzam.test",
          cookie: "vind_session=valid_human_token"
        }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, mockProviderActive.id);
      assert.equal(body.data.legal_name, "Pt Vindzam Technology Legal");
      assert.equal(body.data.display_name, "Vindzam Digital Services");
    });

    it("GET /api/v1/providers/:providerId/offerings returns 200 OK with paginated offering summaries", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${mockProviderActive.id}/offerings?limit=5`,
        headers: {
          host: "vindzam.test",
          cookie: "vind_session=valid_human_token"
        }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(Array.isArray(body.data), true);
      assert.equal(body.data[0].offering_code, "OFF-001");
    });

    it("GET /api/v1/providers/:providerId/offerings returns 400 VALIDATION_FAILED if status query parameter is supplied", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/providers/${mockProviderActive.id}/offerings?status=ACTIVE`,
        headers: {
          host: "vindzam.test",
          cookie: "vind_session=valid_human_token"
        }
      });

      assert.equal(response.statusCode, 400);
      const body = response.json();
      assert.equal(body.code, "VALIDATION_FAILED");
    });

    it("GET /api/v1/catalog/offerings/:offeringId returns 200 OK with OfferingDetail DTO and linked resources", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/catalog/offerings/${mockOffering1.id}`,
        headers: {
          host: "vindzam.test",
          cookie: "vind_session=valid_human_token"
        }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, mockOffering1.id);
      assert.equal(body.data.resources[0].resource_code, "RES-001");
      assert.equal(body.data.resources[0].quantity, 2);
    });

    it("GET /api/v1/catalog/offerings/:offeringId returns 400 for invalid offeringId UUID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/catalog/offerings/bad-offering-id",
        headers: {
          host: "vindzam.test",
          cookie: "vind_session=valid_human_token"
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });

    it("GET /api/v1/catalog/packages/:packageId returns 200 OK with PackageDetail DTO and package items", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/catalog/packages/${mockPackage1.id}`,
        headers: {
          host: "vindzam.test",
          cookie: "vind_session=valid_human_token"
        }
      });

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.data.id, mockPackage1.id);
      assert.equal(body.data.anchor_offering_id, mockOffering1.id);
      assert.equal(body.data.items[0].offering_code, "OFF-001");
    });

    it("GET /api/v1/catalog/packages/:packageId returns 400 for invalid packageId UUID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/catalog/packages/bad-package-id",
        headers: {
          host: "vindzam.test",
          cookie: "vind_session=valid_human_token"
        }
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "VALIDATION_FAILED");
    });
  });
});
