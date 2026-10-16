import { PetDetail } from "@/features/pets/pets";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PetDetail id={id} />;
}
