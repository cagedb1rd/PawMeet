import { PetForm } from "@/features/forms/pet-form";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PetForm id={id} />;
}
