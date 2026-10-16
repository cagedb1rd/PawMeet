import { Suspense } from "react";
import { PetForm } from "@/features/forms/forms";
export default function Page() {
  return (
    <Suspense>
      <PetForm />
    </Suspense>
  );
}
