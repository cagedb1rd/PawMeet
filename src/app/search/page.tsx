import { Suspense } from "react";
import { Search } from "@/features/community/search";
export default function Page() {
  return (
    <Suspense>
      <Search />
    </Suspense>
  );
}
