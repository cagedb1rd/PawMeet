import { Suspense } from "react";
import { ActivityForm } from "@/features/forms/forms";
export default function Page() {
  return (
    <Suspense>
      <ActivityForm />
    </Suspense>
  );
}
