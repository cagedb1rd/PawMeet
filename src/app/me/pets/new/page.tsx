import { Suspense } from "react";
import { PetForm } from "@/features/forms/pet-form";
export default function Page() {
  return (
    <Suspense>
      <PetForm />
    </Suspense>
  );
}
