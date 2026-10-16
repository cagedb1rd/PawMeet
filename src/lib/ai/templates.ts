import { ChecklistInput } from "@/domain/schemas";
import { genericCare } from "./validation";
/** Existing notes remain quotations requiring owner review; no generated care facts. */
export function checklistTemplate(facts: string): ChecklistInput {
  return {
    items: [
      ...facts
        .split("\n")
        .filter(Boolean)
        .slice(0, 8)
        .map((detail) => ({
          title: "已有资料（请复核）",
          detail: detail.slice(0, 300),
          needsConfirmation: true,
        })),
      ...genericCare
        .slice(0, 3)
        .map((detail) => ({
          title: "交接待确认",
          detail,
          needsConfirmation: true,
        })),
    ],
  };
}
