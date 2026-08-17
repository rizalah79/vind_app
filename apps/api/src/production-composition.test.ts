import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildProductionApp } from "./server.js";
import { LocalMediaDeliveryAdapter } from "./media/delivery-adapter.js";

describe("Production Database Composition Tests (Section D)", () => {
  const channelHostEnv = {
    DATABASE_URL: "postgresql://vind_app_runtime:secret@localhost:5432/vind_app_dev",
    VINDZAM_ALLOWED_HOSTS: "vindzam.test,localhost",
    VINDLOKA_ALLOWED_HOSTS: "vindloka.test"
  };

  const mockSessionDbClient = {
    async query() {
      return { rows: [] };
    }
  };

  const mockDomainDbClient = {
    async $queryRaw() {
      return [];
    },
    async $transaction(fn: any) {
      return fn(this);
    },
    provider_profiles: {
      async findFirst() { return null; }
    },
    channel_publications: {
      async findMany() { return []; },
      async findFirst() { return null; }
    },
    offerings: {
      async findMany() { return []; },
      async findFirst() { return null; }
    },
    packages: {
      async findFirst() { return null; }
    }
  };

  it("buildProductionApp registers public and authenticated B3 routes when properly wired adapters are supplied", async () => {
    const app = await buildProductionApp({
      env: channelHostEnv,
      sessionDbClient: mockSessionDbClient,
      domainDbClient: mockDomainDbClient as any,
      readinessDependencies: []
    });

    const publicRes = await app.inject({
      method: "GET",
      url: "/api/v1/public/providers/00000000-0000-4000-a000-000000000001",
      headers: { host: "vindzam.test" }
    });
    // 404 because mock returns empty array, but route is registered and answered
    assert.equal(publicRes.statusCode, 404);

    const authRes = await app.inject({
      method: "GET",
      url: "/api/v1/providers/00000000-0000-4000-a000-000000000001",
      headers: { host: "vindzam.test" }
    });
    // 401 because unauthenticated, but route is registered
    assert.equal(authRes.statusCode, 401);

    await app.close();
  });

  it("buildProductionApp throws when invalid sessionDbClient adapter is supplied", async () => {
    await assert.rejects(
      async () => {
        await buildProductionApp({
          env: channelHostEnv,
          sessionDbClient: { invalid: true } as any,
          domainDbClient: mockDomainDbClient as any,
          readinessDependencies: []
        });
      },
      (err: Error) => {
        return err.message.includes("FATAL: Invalid sessionDbClient supplied");
      }
    );
  });

  it("buildProductionApp throws when invalid domainDbClient adapter (e.g. pg client) is supplied for domain B3 routes", async () => {
    await assert.rejects(
      async () => {
        await buildProductionApp({
          env: channelHostEnv,
          sessionDbClient: mockSessionDbClient,
          domainDbClient: mockSessionDbClient as any,
          readinessDependencies: []
        });
      },
      (err: Error) => {
        return err.message.includes("FATAL: Invalid domainDbClient supplied");
      }
    );
  });

  it("does NOT attempt to close injected test clients on app.close()", async () => {
    let sessionClosed = false;
    let domainClosed = false;

    const injectedSessionClient = {
      ...mockSessionDbClient,
      end: async () => { sessionClosed = true; }
    };

    const injectedDomainClient = {
      ...mockDomainDbClient,
      $disconnect: async () => { domainClosed = true; }
    };

    const app = await buildProductionApp({
      env: channelHostEnv,
      sessionDbClient: injectedSessionClient,
      domainDbClient: injectedDomainClient as any,
      readinessDependencies: []
    });

    await app.close();

    assert.equal(sessionClosed, false, "Injected session client must NOT be closed by app.close()");
    assert.equal(domainClosed, false, "Injected domain client must NOT be closed by app.close()");
  });

  it("LocalMediaDeliveryAdapter fails closed if explicit signing secret or base URL is missing", () => {
    const origSecret = process.env.MEDIA_DELIVERY_SIGNING_SECRET;
    const origUrl = process.env.MEDIA_DELIVERY_BASE_URL;
    delete process.env.MEDIA_DELIVERY_SIGNING_SECRET;
    delete process.env.MEDIA_DELIVERY_BASE_URL;

    try {
      assert.throws(
        () => new LocalMediaDeliveryAdapter(),
        (err: Error) => err.message.includes("FATAL: Media delivery infrastructure unconfigured")
      );
    } finally {
      if (origSecret) process.env.MEDIA_DELIVERY_SIGNING_SECRET = origSecret;
      if (origUrl) process.env.MEDIA_DELIVERY_BASE_URL = origUrl;
    }
  });

  it("Media delivery route fails closed with 503 DEPENDENCY_UNAVAILABLE if delivery infrastructure is missing", async () => {
    const origSecret = process.env.MEDIA_DELIVERY_SIGNING_SECRET;
    const origUrl = process.env.MEDIA_DELIVERY_BASE_URL;
    delete process.env.MEDIA_DELIVERY_SIGNING_SECRET;
    delete process.env.MEDIA_DELIVERY_BASE_URL;

    try {
      const app = await buildProductionApp({
        env: channelHostEnv,
        sessionDbClient: mockSessionDbClient,
        domainDbClient: mockDomainDbClient as any,
        readinessDependencies: []
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/public/media/00000000-0000-4000-a000-000000000501/delivery",
        headers: { host: "vindzam.test" }
      });

      assert.equal(res.statusCode, 503);
      const body = res.json();
      assert.equal(body.code, "DEPENDENCY_UNAVAILABLE");

      await app.close();
    } finally {
      if (origSecret) process.env.MEDIA_DELIVERY_SIGNING_SECRET = origSecret;
      if (origUrl) process.env.MEDIA_DELIVERY_BASE_URL = origUrl;
    }
  });
});
