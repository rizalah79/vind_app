import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import type { SessionStore, ResolvedSessionContext } from "./auth/session.js";
import type { DatabaseClient } from "@vind/database";
import { LocalMediaDeliveryAdapter, StorageDependencyError } from "./media/delivery-adapter.js";

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

describe("B4 — Media Delivery Contract APIs", () => {
  const channelHostConfig = {
    vindzamAllowedHosts: ["vindzam.test", "localhost"],
    vindlokaAllowedHosts: ["vindloka.test"]
  };

  const mockProvider1 = {
    id: "00000000-0000-4000-a000-000000000001",
    display_name: "Provider One"
  };

  const mockProvider2 = {
    id: "00000000-0000-4000-a000-000000000002",
    display_name: "Provider Two"
  };

  const safeActiveAsset = {
    id: "00000000-0000-4000-a000-000000000501",
    owner_provider_profile_id: mockProvider1.id,
    media_type: "IMAGE",
    file_name: "hero_banner.jpg",
    file_size_bytes: BigInt(123456),
    mime_type: "image/jpeg",
    checksum_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    storage_path: "private/storage/internal/hero_banner_secret.jpg",
    status: "ACTIVE",
    created_at: new Date("2026-08-01T10:00:00.000Z"),
    updated_at: new Date("2026-08-01T10:00:00.000Z"),
    media_rights: [{ id: "right-1", status: "ACTIVE", effective_from: new Date("2026-01-01"), effective_to: null }],
    media_links: [{ id: "link-1", link_role: "PUBLIC_LISTING", link_status: "ACTIVE", effective_from: new Date("2026-01-01"), effective_to: null }]
  };

  const quarantinedAsset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000502",
    status: "QUARANTINED"
  };

  const unsafeAsset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000503",
    status: "UNSAFE"
  };

  const infectedAsset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000504",
    status: "INFECTED"
  };

  const unreleasedAsset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000505",
    status: "UNRELEASED"
  };

  const rightsIneligibleAsset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000506",
    media_rights: [{ id: "right-2", status: "EXPIRED", effective_from: new Date("2025-01-01"), effective_to: new Date("2025-12-31") }]
  };

  const originalWithoutPublicLinkAsset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000507",
    media_links: []
  };

  const provider2Asset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000508",
    owner_provider_profile_id: mockProvider2.id
  };

  const allAssetsMap = new Map<string, any>([
    [safeActiveAsset.id, safeActiveAsset],
    [quarantinedAsset.id, quarantinedAsset],
    [unsafeAsset.id, unsafeAsset],
    [infectedAsset.id, infectedAsset],
    [unreleasedAsset.id, unreleasedAsset],
    [rightsIneligibleAsset.id, rightsIneligibleAsset],
    [originalWithoutPublicLinkAsset.id, originalWithoutPublicLinkAsset],
    [provider2Asset.id, provider2Asset]
  ]);

  function createMockDb(): DatabaseClient {
    const db: any = {
      async $queryRaw() { return []; },
      async $executeRawUnsafe() { return 1; },
      async $transaction(fn: any) {
        return fn(db);
      },
      media_assets: {
        async findFirst({ where }: any) {
          const asset = allAssetsMap.get(where.id);
          if (!asset) return null;
          if (where.status && where.status !== asset.status) return null;
          if (where.owner_provider_profile_id && where.owner_provider_profile_id !== asset.owner_provider_profile_id) return null;

          if (where.media_rights?.some) {
            const now = new Date();
            const validRight = asset.media_rights.find((r: any) => {
              if (r.status !== "ACTIVE") return false;
              if (r.effective_from > now) return false;
              if (r.effective_to && r.effective_to <= now) return false;
              return true;
            });
            if (!validRight) return null;
          }

          if (where.media_links?.some) {
            const now = new Date();
            const validLink = asset.media_links.find((l: any) => {
              if (l.link_status !== "ACTIVE") return false;
              if (l.link_role !== "PUBLIC_LISTING") return false;
              if (l.effective_from > now) return false;
              if (l.effective_to && l.effective_to <= now) return false;
              return true;
            });
            if (!validLink) return null;
          }

          return asset;
        }
      }
    };
    return db as DatabaseClient;
  }

  const sessionStore = new TestInMemorySessionStore();
  const humanToken = "valid_human_session_token_b4";
  sessionStore.addSession(humanToken, {
    sessionId: "sess-b4-001",
    accountKey: "acc-b4-001",
    personKey: "person-b4-001",
    actorKind: "HUMAN",
    authorityPlane: "LOCAL",
    membershipKey: "mem-b4-001",
    localAssignmentKey: "assign-b4-001",
    platformAssignmentKey: null,
    serviceGrantKey: null,
    organizationKey: "org-b4-001",
    workspaceKey: "ws-b4-001",
    providerKey: mockProvider1.id,
    authorityChannelCode: "VINDZAM",
    regionKey: "ID-JK",
    authAssuranceLevel: "IAL2_AAL2",
    stepUpVerified: false,
    absoluteExpiresAt: new Date(Date.now() + 28800000)
  });

  const testDeliveryAdapter = new LocalMediaDeliveryAdapter({
    signingSecret: "test_secret_for_b4_acceptance_key",
    baseUrl: "https://media.cdn.test/delivery",
    expiresInSeconds: 900
  });

  const app = buildApp({
    sessionStore,
    channelHostConfig,
    domainDbClient: createMockDb(),
    mediaDeliveryAdapter: testDeliveryAdapter
  });

  it("1. eligible safe derivative => 200 OK success with delivery DTO", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${safeActiveAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.media_id, safeActiveAsset.id);
    assert.equal(body.data.content_type, "image/jpeg");
    assert.equal(body.data.file_name, undefined);
    assert.equal(body.data.file_size_bytes, undefined);
    assert.equal(body.data.checksum_sha256, undefined);
    assert.equal(typeof body.data.delivery_url, "string");
    assert.equal(typeof body.data.expires_at, "string");
    assert.equal(body.meta.request_id !== undefined, true);
  });

  it("2. missing media => 404 RESOURCE_NOT_FOUND", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/media/00000000-0000-4000-a000-999999999999/delivery",
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.code, "RESOURCE_NOT_FOUND");
  });

  it("3. quarantined media => 404 RESOURCE_NOT_FOUND", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${quarantinedAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.code, "RESOURCE_NOT_FOUND");
  });

  it("4. unsafe/failed scan => 404 RESOURCE_NOT_FOUND", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${unsafeAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.code, "RESOURCE_NOT_FOUND");
  });

  it("5. moderation blocked (INFECTED / UNRELEASED) => 404 RESOURCE_NOT_FOUND", async () => {
    const resInfected = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${infectedAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });
    assert.equal(resInfected.statusCode, 404);

    const resUnreleased = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${unreleasedAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });
    assert.equal(resUnreleased.statusCode, 404);
  });

  it("6. rights-ineligible => 404 RESOURCE_NOT_FOUND", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${rightsIneligibleAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.code, "RESOURCE_NOT_FOUND");
  });

  it("7. original without safe derivative / public link => 404 RESOURCE_NOT_FOUND", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${originalWithoutPublicLinkAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.code, "RESOURCE_NOT_FOUND");
  });

  it("8. malformed ID => 400 VALIDATION_FAILED", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/media/not-a-valid-uuid/delivery",
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.equal(body.code, "VALIDATION_FAILED");
  });

  it("9. adapter failure => 503 DEPENDENCY_UNAVAILABLE", async () => {
    testDeliveryAdapter.setShouldFailForTesting(true);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/media/${safeActiveAsset.id}/delivery`,
        headers: { host: "vindzam.test" }
      });

      assert.equal(response.statusCode, 503);
      const body = response.json();
      assert.equal(body.code, "DEPENDENCY_UNAVAILABLE");
    } finally {
      testDeliveryAdapter.setShouldFailForTesting(false);
    }
  });

  it("10. no storage secret/path leakage in DTO or headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${safeActiveAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 200);
    const bodyStr = response.payload;
    assert.equal(bodyStr.includes("private/storage/internal"), false);
    assert.equal(bodyStr.includes("hero_banner_secret"), false);
    assert.equal(bodyStr.includes("test_secret_for_b4_acceptance_key"), false);
  });

  it("11. signed URL expiry contract & cache control", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${safeActiveAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store, max-age=0, private");
    assert.equal(response.headers["pragma"], "no-cache");

    const body = response.json();
    assert.equal(body.data.delivery_url.includes("token="), true);
    assert.equal(body.data.delivery_url.includes("expires="), true);
    const expiresAt = new Date(body.data.expires_at).getTime();
    assert.equal(expiresAt > Date.now(), true);
  });

  it("12. authenticated media delivery endpoint works for valid session owner", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/media/${safeActiveAsset.id}/delivery`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${humanToken}`
      }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.media_id, safeActiveAsset.id);
  });

  it("13. authenticated RLS / provider context isolation returns 404 for unowned media", async () => {
    const mockDbWithRls = createMockDb();
    const appRls = buildApp({
      sessionStore,
      channelHostConfig,
      domainDbClient: mockDbWithRls,
      mediaDeliveryAdapter: testDeliveryAdapter
    });

    // Asset owned by Provider 2 requested by Provider 1 session -> 404
    const response = await appRls.inject({
      method: "GET",
      url: `/api/v1/media/${provider2Asset.id}/delivery`,
      headers: {
        host: "vindzam.test",
        cookie: `vind_session=${humanToken}`
      }
    });

    assert.equal(response.statusCode, 404);
  });
});
