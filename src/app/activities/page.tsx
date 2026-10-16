import { Suspense } from "react";
import { Activities } from "@/features/activities/activities";
export default function Page() {
  return (
    <Suspense>
      <Activities />
    </Suspense>
  );
}
