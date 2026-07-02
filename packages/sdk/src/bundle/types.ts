// Bundle types — the Sovereign AI-specific contract. A "harness bundle" is
// a directory with the three-tier shape described in
// sovereign-ai-docs/business/process/three-tier-architecture.md:
//
//   <bundle>/business/      tier 1 — authoritative data (read-only to runtime)
//   <bundle>/harness/       tier 2 — tools + schemas (read-only to runtime)
//   <bundle>/state/         tier 3 — per-installation state (runtime writes here)
//
// The runtime reads tiers 1-2 as input, writes tier 3 as output.

export type BundleIndex = {
  repo?: string;
  description?: string;
  updated?: string;
  /** Phase 13.4 follow-up (Item 19) — operator-declared stable identity for
   *  this bundle. When present, used by the memory subsystem to scope per-
   *  project MEMORY.md. When absent, the canonical bundle path is hashed
   *  instead. Optional; bundles that don't set it still get a stable
   *  per-machine identity. */
  projectId?: string;
  reading_order?: string[];
  documents?: BundleDocEntry[];
};

export type BundleDocEntry = {
  doc_id: string;
  file: string;
  title: string;
  version: number;
  status: string;
  supersedes?: number;
  summary?: string;
  depends_on?: string[];
};

export type Bundle = {
  /** Absolute path to the bundle root. */
  root: string;
  /** Parsed index.yaml. */
  index: BundleIndex;
  /** Tier 1 — loaded lazily; keys are relative paths like "business/strategy/executive.md". */
  business: Map<string, string>;
  /** Tier 3 content, eagerly loaded: CONTEXT.md + memory/*. */
  state: {
    context: string | null;
    preferences: string | null;
    decisionsMade: string | null;
    sessionLog: string | null;
  };
  /** Tier 2 schema paths (JSON Schemas loaded on demand). */
  schemaPaths: {
    entity: string;
    decision: string;
    openQuestion: string;
    tags: string;
  };
};
