import { HelpDetail } from "@/features/help/detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HelpDetail id={id} />;
}
