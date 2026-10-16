import Link from "next/link";

export function NearbyTabs({ help = false }: { help?: boolean }) {
  return (
    <nav className="nearby-tabs" aria-label="附近分类">
      <Link href="/discover" aria-current={!help ? "page" : undefined}>
        附近宠友
      </Link>
      <Link href="/help" aria-current={help ? "page" : undefined}>
        临时互助
      </Link>
    </nav>
  );
}
