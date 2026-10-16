import { Suspense } from "react";
import { Help } from "@/features/help/help";
export default function Page() {
  return (
    <Suspense>
      <Help />
    </Suspense>
  );
}
