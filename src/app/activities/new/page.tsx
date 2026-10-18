import { Suspense } from "react";
import { ActivityForm } from "@/features/forms/activity-form";
export default function Page() {
  return (
    <Suspense>
      <ActivityForm />
    </Suspense>
  );
}
