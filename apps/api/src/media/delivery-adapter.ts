import crypto from "node:crypto";

export interface MediaDeliveryRequest {
  mediaId: string;
  storagePath: string;
  mimeType: string;
}

export interface MediaDeliveryResult {
  deliveryUrl: string;
  expiresAt: string;
}

export class StorageDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageDependencyError";
  }
}

export interface MediaDeliveryAdapter {
  generateDeliveryUrl(request: MediaDeliveryRequest): Promise<MediaDeliveryResult>;
}

export interface LocalMediaDeliveryAdapterOptions {
  signingSecret?: string | undefined;
  baseUrl?: string | undefined;
  expiresInSeconds?: number | undefined;
  shouldFailForTesting?: boolean | undefined;
}

export class LocalMediaDeliveryAdapter implements MediaDeliveryAdapter {
  private readonly signingSecret: string;
  private readonly baseUrl: string;
  private readonly expiresInSeconds: number;
  private shouldFailForTesting: boolean;

  constructor(options: LocalMediaDeliveryAdapterOptions = {}) {
    const secret = options.signingSecret ?? process.env.MEDIA_DELIVERY_SIGNING_SECRET;
    const url = options.baseUrl ?? process.env.MEDIA_DELIVERY_BASE_URL;

    if (!secret || !secret.trim()) {
      throw new Error("FATAL: Media delivery infrastructure unconfigured. Explicit signing secret is required.");
    }
    if (!url || !url.trim()) {
      throw new Error("FATAL: Media delivery infrastructure unconfigured. Explicit base URL is required.");
    }

    this.signingSecret = secret.trim();
    this.baseUrl = url.trim();
    this.expiresInSeconds = options.expiresInSeconds ?? 900; // 15 minutes default
    this.shouldFailForTesting = options.shouldFailForTesting ?? false;
  }

  setShouldFailForTesting(shouldFail: boolean): void {
    this.shouldFailForTesting = shouldFail;
  }

  async generateDeliveryUrl(request: MediaDeliveryRequest): Promise<MediaDeliveryResult> {
    if (this.shouldFailForTesting) {
      throw new StorageDependencyError("Object storage dependency service unavailable");
    }

    const expiresAtDate = new Date(Date.now() + this.expiresInSeconds * 1000);
    const expiresAtISO = expiresAtDate.toISOString();

    const signaturePayload = `${request.mediaId}:${expiresAtISO}`;
    const hmac = crypto.createHmac("sha256", this.signingSecret);
    hmac.update(signaturePayload);
    const signature = hmac.digest("hex");

    const deliveryUrl = `${this.baseUrl}/${request.mediaId}?token=${signature}&expires=${encodeURIComponent(expiresAtISO)}`;

    return {
      deliveryUrl,
      expiresAt: expiresAtISO
    };
  }
}

export function createLocalMediaDeliveryAdapter(options: LocalMediaDeliveryAdapterOptions = {}): MediaDeliveryAdapter {
  return new LocalMediaDeliveryAdapter(options);
}
