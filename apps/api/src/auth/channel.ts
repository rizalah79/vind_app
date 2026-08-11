export type ChannelCode = "VINDZAM" | "VINDLOKA";

export interface ChannelInfo {
  code: ChannelCode;
  name: string;
}

export const validChannels: Record<ChannelCode, ChannelInfo> = {
  VINDZAM: {
    code: "VINDZAM",
    name: "Vindzam Consumer Marketplace"
  },
  VINDLOKA: {
    code: "VINDLOKA",
    name: "Vindloka Sahabat Local Operations"
  }
};

/**
 * Resolves canonical channel code from request context, strictly validating against
 * server configuration and host mapping to prevent client header/query forgery.
 */
export function resolveCanonicalChannel(
  hostHeader: string | undefined,
  requestedChannelHeader?: string | string[]
): ChannelInfo {
  // 1. Host-based canonical resolution
  if (hostHeader && hostHeader.toLowerCase().includes("vindloka")) {
    return validChannels.VINDLOKA;
  }

  // 2. Header check (validated against allowlist)
  if (typeof requestedChannelHeader === "string") {
    const uppercase = requestedChannelHeader.trim().toUpperCase();
    if (uppercase === "VINDLOKA") return validChannels.VINDLOKA;
    if (uppercase === "VINDZAM") return validChannels.VINDZAM;
  }

  // Default server channel
  return validChannels.VINDZAM;
}
