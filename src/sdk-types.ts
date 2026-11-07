import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * The memory capability shape, taken from the public plugin entry API instead of the
 * removal-pending `plugin-sdk/memory-host-core` facade.
 */
export type MemoryPluginCapability = Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0];

export type LearnMedium = "skills" | "memory";

/**
 * Structural copy of the host's `/learn` contribution (openclaw#191665, on main after
 * 2026.10.10). No tagged release exports it yet, so it is declared here and the plugin
 * feature-detects `api.registerLearnContribution` at register time.
 */
export type LearnContribution = {
  medium: LearnMedium;
  toolNames: readonly string[];
  requiredToolNames?: readonly string[];
  buildGuidance: (params: { availableTools: Set<string>; media: ReadonlySet<LearnMedium> }) => {
    lines: readonly string[];
    appendix?: readonly string[];
  };
};

/**
 * The memory-only `/learn` fields that main carried between openclaw#181879 and #191665. They
 * never shipped in a tagged release; hosts built from main in that window still read them.
 */
export type LegacyLearnCapabilityFields = {
  learnToolNames: readonly string[];
  learnGuidanceBuilder: (params: { availableTools: Set<string> }) => string[];
};

type LearnContributionRegistrar = { registerLearnContribution?: unknown };

/** Returns the host's `registerLearnContribution` when this host has the generic seam. */
export function resolveLearnRegistrar(
  api: OpenClawPluginApi,
): ((contribution: LearnContribution) => void) | undefined {
  const candidate = (api as LearnContributionRegistrar).registerLearnContribution;
  if (typeof candidate !== "function") {
    return undefined;
  }
  return (contribution) => {
    candidate.call(api, contribution);
  };
}
