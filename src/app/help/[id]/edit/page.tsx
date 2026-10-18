import { HelpForm } from "@/features/help/form";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HelpForm id={id} />;
}
