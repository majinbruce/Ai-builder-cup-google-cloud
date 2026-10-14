"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** The landing page's three sections, then the demo, which needs no account. */
const SECTIONS = [
  { href: "/#process", label: "Process" },
  { href: "/#lesson", label: "Lesson" },
  { href: "/#signals", label: "Signals" },
] as const;

export function NavLinks() {
  const pathname = usePathname();
  const onDemo = pathname === "/demo";

  return (
    <div className="flex items-center gap-[max(14px,2.1vw)] text-[max(13px,0.95vw)] font-medium whitespace-nowrap">
      {SECTIONS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="hidden transition-opacity hover:opacity-60 md:inline nua-focus"
        >
          {link.label}
        </Link>
      ))}
      <Link
        href="/demo"
        aria-current={onDemo ? "page" : undefined}
        className={cn(
          "transition-opacity hover:opacity-60 nua-focus",
          onDemo && "underline underline-offset-4"
        )}
      >
        Demo
      </Link>
    </div>
  );
}
