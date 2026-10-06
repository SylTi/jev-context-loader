export const ROUTER_NAME = 'jev-skills-router';
export type Scope = 'global' | 'project';
export type OriginalPolicy = 'disable' | 'delete' | 'keep';

export interface InstalledSkill {
  name: string;
  path: string;
  scope: Scope;
  agents: string[];
  source?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
}

export interface Installation {
  scope: Scope;
  root: string;
  routerPath: string;
  stateDirectory: string;
  providers: string[];
}

export interface ImportRecord {
  name: string;
  sourcePath: string;
  destination: string;
  contentHash: string;
  backup?: string;
}

export interface CatalogState {
  policy?: OriginalPolicy;
  ignored: string[];
  approved: string[];
  imports: Record<string, ImportRecord>;
}

export interface Candidate {
  id: string;
  name: string;
  providers: string[];
  sourcePath: string;
}

export interface ReconcileResult {
  pending: Candidate[];
  conflicts: Array<{ name: string; path: string; reason: string }>;
  imported: number;
}

export type InventoryReader = (root: string, global: boolean) => Promise<InstalledSkill[]>;

export type DestinationResult = { status: 'selected'; installation: Installation } |
  { status: 'scope_required'; question: string; destinations: Array<{ scope: Scope; path: string }> };
