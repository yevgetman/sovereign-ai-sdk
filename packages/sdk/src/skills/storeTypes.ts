export type SkillStoreListOptions = { limit?: number; cursor?: string };
export type SkillStoreListPage = {
  names: string[];
  truncated: boolean;
  generation: string;
  nextCursor?: string;
};

/** Portable, explicit writable skill storage. No adapter is chosen implicitly. */
export type SkillStoreFile = { data: Uint8Array; mode?: number };
export type SkillStoredEntry = {
  name: string;
  content: string;
  revision: string;
  files: ReadonlyMap<string, SkillStoreFile>;
  directoryModes?: ReadonlyMap<string, number>;
  path?: string;
};

export type SkillMutation = {
  action: 'create' | 'edit' | 'delete';
  name: string;
  content?: string;
  /** Required for edit/delete. Obtain this from read() or the last commit. */
  expectedRevision?: string;
  /** Complete replacement tree. Omit to retain existing sidecar resources. */
  files?: ReadonlyMap<string, SkillStoreFile>;
  directoryModes?: ReadonlyMap<string, number>;
};

export type SkillMutationEvent = {
  action: SkillMutation['action'];
  name: string;
  revision?: string;
  previousRevision?: string;
  path?: string;
};

export type SkillMutationResult = {
  event: SkillMutationEvent;
  entry?: SkillStoredEntry;
};

export interface SkillWritableStore {
  read(name: string): Promise<SkillStoredEntry | undefined>;
  /** Bounded enumeration; truncated=true is an explicit overflow diagnostic. */
  list(options?: SkillStoreListOptions): Promise<SkillStoreListPage>;
  mutate(change: SkillMutation): Promise<SkillMutationResult>;
  /** Observers receive committed events only; observer errors cannot undo a commit. */
  subscribe(listener: (event: SkillMutationEvent) => void): () => void;
}

/** Worker wire format. These records never reach a provider or a diagnostic response. */
export type SkillStoreWireEntry = {
  name: string;
  files: Record<string, { data: string; mode: number }>;
  directoryModes: Record<string, number>;
  revision: string;
};
export type SkillStoreWorkerRequest = {
  ancestorIdentity: { dev: number; ino: number };
  segments: string[];
  rootPath: string;
  cursor?: string;
  limit?: number;
  name: string;
  action: 'read' | 'list' | SkillMutation['action'];
  expectedRevision?: string;
  files?: SkillStoreWireEntry['files'];
  directoryModes?: Record<string, number>;
  trustTier: import('./types.js').SkillTrustTier;
};
