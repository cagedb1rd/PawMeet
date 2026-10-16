import { Suspense } from "react";
import { Me } from "@/features/me/me";
export default function Page() {
  return (
    <Suspense>
      <Me />
    </Suspense>
  );
}
