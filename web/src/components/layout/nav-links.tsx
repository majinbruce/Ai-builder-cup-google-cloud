"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/demo", label: "Demo" },
  { href: "/localize", label: "My videos" },
] as const;

/** The header's links, with the current section marked for sighted and AT users. */
export function NavLinks() {
  const pathname = usePathname();

  return (
    <>
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground",
              active && "bg-muted text-foreground"
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </>
  );
}
