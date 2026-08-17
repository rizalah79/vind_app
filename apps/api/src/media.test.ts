import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import type { SessionStore, ResolvedSessionContext } from "./auth/session.js";
import type { DatabaseClient } from "@vind/database";
import { LocalMediaDeliveryAdapter, StorageDependencyError, type MediaDeliveryRequest } from "./media/delivery-adapter.js";

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
    updated_at: new Date("2026-08-01T10:00:00.000Z")
  };

  const safeDerivative = {
    id: "00000000-0000-4000-a000-000000000601",
    source_media_asset_id: safeActiveAsset.id,
    variant_code: "CANONICAL",
    is_canonical: true,
    content_type: "image/jpeg",
    storage_locator: "canonical/derivatives/safe_active_derivative.jpg",
    checksum_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    scan_status: "CLEAN",
    moderation_status: "APPROVED",
    delivery_status: "DELIVERABLE",
    width_px: 1024,
    height_px: 768
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
    id: "00000000-0000-4000-a000-000000000506"
  };

  const originalWithoutPublicLinkAsset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000507"
  };

  const provider2Asset = {
    ...safeActiveAsset,
    id: "00000000-0000-4000-a000-000000000508",
    owner_provider_profile_id: mockProvider2.id
  };

  function createMockDb(shouldDbQueryThrow = false): DatabaseClient {
    const db: any = {
      async $queryRaw(strings: TemplateStringsArray, ...values: any[]) {
        if (shouldDbQueryThrow) {
          throw new Error("Simulated database failure during read_public_media_delivery query");
        }
        const mediaId = values[0];
        if (mediaId === safeActiveAsset.id) {
          return [{
            media_id: safeActiveAsset.id,
            derivative_id: safeDerivative.id,
            storage_locator: safeDerivative.storage_locator,
            content_type: safeDerivative.content_type,
            variant_code: safeDerivative.variant_code,
            width_px: safeDerivative.width_px,
            height_px: safeDerivative.height_px
          }];
        }
        return [];
      },
      async $executeRawUnsafe() { return 1; },
      async $transaction(fn: any) {
        return fn(db);
      },
      media_derivatives: {
        async findFirst({ where }: any) {
          const mediaId = where.source_media_asset_id;
          if (mediaId === safeActiveAsset.id) {
            return {
              id: safeDerivative.id,
              source_media_asset_id: safeActiveAsset.id,
              storage_locator: safeDerivative.storage_locator,
              content_type: safeDerivative.content_type
            };
          }
          return null;
        }
      },
      media_assets: {
        async findFirst() {
          throw new Error("CRITICAL SAFETY VIOLATION: media_assets.findFirst was called on fallback!");
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
    assert.equal(body.data.storage_path, undefined);
    assert.equal(body.data.storage_locator, undefined);
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

  it("10. no storage secret/path/locator leakage in DTO or headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${safeActiveAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 200);
    const bodyStr = response.payload;
    assert.equal(bodyStr.includes("private/storage/internal"), false);
    assert.equal(bodyStr.includes("hero_banner_secret"), false);
    assert.equal(bodyStr.includes("canonical/derivatives"), false);
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
    const appRls = buildApp({
      sessionStore,
      channelHostConfig,
      domainDbClient: createMockDb(),
      mediaDeliveryAdapter: testDeliveryAdapter
    });

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

  it("14. public DB function error throws internal error and NEVER falls back to media_assets", async () => {
    const failingDbApp = buildApp({
      sessionStore,
      channelHostConfig,
      domainDbClient: createMockDb(true),
      mediaDeliveryAdapter: testDeliveryAdapter
    });

    const response = await failingDbApp.inject({
      method: "GET",
      url: `/api/v1/public/media/${safeActiveAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 500);
    const body = response.json();
    assert.equal(body.code, "INTERNAL_ERROR");
  });

  it("15. storagePath compatibility field is absent from MediaDeliveryRequest and storage_path is never sent to adapter", async () => {
    let capturedRequest: MediaDeliveryRequest | null = null;
    const captureAdapter = {
      async generateDeliveryUrl(req: MediaDeliveryRequest) {
        capturedRequest = req;
        return { deliveryUrl: "https://media.test/captured", expiresAt: new Date().toISOString() };
      }
    };

    const captureApp = buildApp({
      sessionStore,
      channelHostConfig,
      domainDbClient: createMockDb(),
      mediaDeliveryAdapter: captureAdapter
    });

    const response = await captureApp.inject({
      method: "GET",
      url: `/api/v1/public/media/${safeActiveAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 200);
    assert.notEqual(capturedRequest, null);
    assert.equal(capturedRequest!.storageLocator, safeDerivative.storage_locator);
    assert.equal((capturedRequest as any).storagePath, undefined);
  });

  it("16. storageLocator is bound in HMAC signature payload and signature changes when storageLocator changes", async () => {
    const req1: MediaDeliveryRequest = {
      mediaId: safeActiveAsset.id,
      storageLocator: "canonical/derivatives/v1.jpg",
      mimeType: "image/jpeg"
    };

    const req2: MediaDeliveryRequest = {
      mediaId: safeActiveAsset.id,
      storageLocator: "canonical/derivatives/v2_modified.jpg",
      mimeType: "image/jpeg"
    };

    const res1 = await testDeliveryAdapter.generateDeliveryUrl(req1);
    const res2 = await testDeliveryAdapter.generateDeliveryUrl(req2);

    const token1 = new URL(res1.deliveryUrl).searchParams.get("token");
    const token2 = new URL(res2.deliveryUrl).searchParams.get("token");

    assert.notEqual(token1, token2, "Adapter signature must change when storageLocator changes");
  });

  it("17. storageLocator and storagePath are NOT serialized in client response JSON", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/media/${safeActiveAsset.id}/delivery`,
      headers: { host: "vindzam.test" }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(Object.prototype.hasOwnProperty.call(body.data, "storage_locator"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body.data, "storage_path"), false);
  });
});
