import { HttpProblemError } from "../errors.js";

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
 * Resolves canonical channel strictly from trusted server context (Host header mapping).
 * Client-supplied headers/query parameters MUST NOT become canonical authority.
 */
export function resolveCanonicalChannel(
  hostHeader: string | undefined,
  requestedPresentationChannel?: string | string[]
): ChannelInfo {
  let canonicalChannel: ChannelInfo = validChannels.VINDZAM;

  if (hostHeader) {
    const lowerHost = hostHeader.toLowerCase();
    if (lowerHost.includes("vindloka")) {
      canonicalChannel = validChannels.VINDLOKA;
    } else if (lowerHost.includes("vindzam")) {
      canonicalChannel = validChannels.VINDZAM;
    }
  }

  // If a client provides a presentation hint, validate it against canonical server host authority.
  if (typeof requestedPresentationChannel === "string") {
    const hint = requestedPresentationChannel.trim().toUpperCase();
    if (hint !== canonicalChannel.code) {
      throw new HttpProblemError({
        code: "VALIDATION_FAILED",
        detail: `Presentation channel hint '${hint}' conflicts with canonical host channel '${canonicalChannel.code}'.`
      });
    }
  }

  return canonicalChannel;
}
