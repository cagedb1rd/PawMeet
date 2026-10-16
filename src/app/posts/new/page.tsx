import { Suspense } from "react";
import { PostForm } from "@/features/forms/forms";
export default function Page() {
  return (
    <Suspense>
      <PostForm />
    </Suspense>
  );
}
