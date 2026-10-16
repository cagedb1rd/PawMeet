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
