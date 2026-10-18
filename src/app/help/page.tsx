import { Suspense } from "react";
import { Help } from "@/features/help/list";
export default function Page() {
  return (
    <Suspense>
      <Help />
    </Suspense>
  );
}
