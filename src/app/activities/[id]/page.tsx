import { ActivityDetail } from "@/features/activities/activities";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ActivityDetail id={id} />;
}
