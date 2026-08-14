import { HttpProblemError } from "../errors.js";

export type ChannelCode = "VINDZAM" | "VINDLOKA";

export interface ChannelInfo {
  code: ChannelCode;
  name: string;
}

export interface ChannelHostConfig {
  vindzamAllowedHosts: string[];
  vindlokaAllowedHosts: string[];
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

export function normalizeHost(host: string): string {
  if (!host) return "";
  let h = host.trim().toLowerCase();
  // Remove port if present
  const portIndex = h.indexOf(":");
  if (portIndex !== -1) {
    h = h.substring(0, portIndex);
  }
  // Remove DNS trailing dot if present
  if (h.endsWith(".")) {
    h = h.substring(0, h.length - 1);
  }
  return h;
}

export function parseChannelHostConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): ChannelHostConfig {
  const parseList = (val?: string): string[] => {
    if (!val) return [];
    return val
      .split(",")
      .map((item) => normalizeHost(item))
      .filter(Boolean);
  };

  return {
    vindzamAllowedHosts: parseList(env.VINDZAM_ALLOWED_HOSTS),
    vindlokaAllowedHosts: parseList(env.VINDLOKA_ALLOWED_HOSTS)
  };
}

export function validateChannelHostConfig(config: ChannelHostConfig): void {
  const vindzamSet = new Set(config.vindzamAllowedHosts.map(normalizeHost));
  const vindlokaSet = new Set(config.vindlokaAllowedHosts.map(normalizeHost));

  for (const host of vindzamSet) {
    if (vindlokaSet.has(host)) {
      throw new Error(`Invalid ChannelHostConfig: host '${host}' appears in both VINDZAM and VINDLOKA allowlists.`);
    }
  }
}

/**
 * Resolves canonical channel strictly from trusted server context (exact Host header allowlist).
 * Substring matching is prohibited. Missing or unlisted hosts fail closed.
 */
export function resolveCanonicalChannel(
  hostHeader: string | undefined,
  channelHostConfig?: ChannelHostConfig,
  requestedPresentationChannel?: string | string[]
): ChannelInfo {
  if (!hostHeader || typeof hostHeader !== "string" || !hostHeader.trim()) {
    throw new HttpProblemError({
      code: "VALIDATION_FAILED",
      detail: "Host header is required for channel resolution."
    });
  }

  if (!channelHostConfig) {
    throw new HttpProblemError({
      code: "VALIDATION_FAILED",
      detail: "Channel host configuration is required for channel resolution."
    });
  }

  const normalizedHost = normalizeHost(hostHeader);
  if (!normalizedHost) {
    throw new HttpProblemError({
      code: "VALIDATION_FAILED",
      detail: "Malformed or invalid Host header."
    });
  }

  const vindzamHosts = configHostSet(channelHostConfig.vindzamAllowedHosts);
  const vindlokaHosts = configHostSet(channelHostConfig.vindlokaAllowedHosts);

  let canonicalChannel: ChannelInfo | undefined;

  if (vindzamHosts.has(normalizedHost)) {
    canonicalChannel = validChannels.VINDZAM;
  } else if (vindlokaHosts.has(normalizedHost)) {
    canonicalChannel = validChannels.VINDLOKA;
  }

  if (!canonicalChannel) {
    throw new HttpProblemError({
      code: "VALIDATION_FAILED",
      detail: `Host '${normalizedHost}' is unknown or unauthorized.`
    });
  }

  // If a client provides a presentation hint, validate it against canonical server host authority.
  if (typeof requestedPresentationChannel === "string" && requestedPresentationChannel.trim()) {
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

function configHostSet(list: string[]): Set<string> {
  return new Set((list || []).map(normalizeHost).filter(Boolean));
}
