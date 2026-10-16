import { PetForm } from "@/features/forms/forms";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PetForm id={id} />;
}
