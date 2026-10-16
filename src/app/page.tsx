import { Suspense } from "react";
import { Home } from "@/features/community/community";
export default function Page() {
  return (
    <Suspense>
      <Home />
    </Suspense>
  );
}
