import { Suspense } from "react";
import { Discover } from "@/features/discover/discover";
export default function Page() {
  return (
    <Suspense>
      <Discover />
    </Suspense>
  );
}
