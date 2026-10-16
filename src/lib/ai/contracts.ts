// Phase 4 extension point: drafts never execute business commands.
export type AiTask =
  | "pet-profile"
  | "social-card"
  | "match-intent"
  | "help-intent"
  | "care-checklist"
  | "post-copy";
export type Draft<T> = {
  data: T;
  source: "manual" | "glm";
  sourceRevision: number;
  actorId: string;
  confirmed: false;
};

// Phase 4 adapters must validate these drafts, then ask the owner to confirm.
// They cannot write storage; saving goes through the same business commands.
export type SocialCardDraft = Draft<import("@/domain/schemas").SocialCardInput>;
export type HelpIntentDraft = Draft<
  Partial<import("@/domain/schemas").HelpInput>
> & { missingFields: string[] };
export type CareChecklistDraft = Draft<
  import("@/domain/schemas").ChecklistInput
> & { petRevision: number; requestRevision: number };
