import { Suspense } from "react";
import { PostForm } from "@/features/forms/post-form";
export default function Page() {
  return (
    <Suspense>
      <PostForm />
    </Suspense>
  );
}
