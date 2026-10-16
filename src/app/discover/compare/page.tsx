import { Suspense } from "react";
import { Compare } from "@/features/cards/cards";
export default function Page() {
  return (
    <Suspense>
      <Compare />
    </Suspense>
  );
}
