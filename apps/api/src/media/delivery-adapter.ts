import crypto from "node:crypto";

export interface MediaDeliveryRequest {
  mediaId: string;
  storagePath: string;
  mimeType: string;
  fileName: string;
  fileSizeBytes: bigint | number;
  checksumSha256: string;
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
  signingSecret?: string;
  baseUrl?: string;
  expiresInSeconds?: number;
  shouldFailForTesting?: boolean;
}

export class LocalMediaDeliveryAdapter implements MediaDeliveryAdapter {
  private readonly signingSecret: string;
  private readonly baseUrl: string;
  private readonly expiresInSeconds: number;
  private shouldFailForTesting: boolean;

  constructor(options: LocalMediaDeliveryAdapterOptions = {}) {
    this.signingSecret = options.signingSecret || process.env.MEDIA_DELIVERY_SIGNING_SECRET || "vind_media_delivery_local_secret_key_32b";
    this.baseUrl = options.baseUrl || process.env.MEDIA_DELIVERY_BASE_URL || "https://media.cdn.vind.app/delivery";
    this.expiresInSeconds = options.expiresInSeconds || 900; // 15 minutes default
    this.shouldFailForTesting = options.shouldFailForTesting || false;
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

    const signaturePayload = `${request.mediaId}:${request.checksumSha256}:${expiresAtISO}`;
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

export function createDefaultMediaDeliveryAdapter(options: LocalMediaDeliveryAdapterOptions = {}): MediaDeliveryAdapter {
  return new LocalMediaDeliveryAdapter(options);
}
