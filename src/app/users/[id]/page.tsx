import { UserProfile } from "@/features/community/user";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <UserProfile id={id} />;
}
