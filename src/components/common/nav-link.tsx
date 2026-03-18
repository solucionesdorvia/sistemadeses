"use client";

import Link, { type LinkProps } from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

type NavLinkProps = LinkProps &
  Omit<React.ComponentProps<typeof Link>, "href"> & {
    activeClassName?: string;
    pendingClassName?: string;
  };

export function NavLink({
  href,
  className,
  activeClassName,
  pendingClassName,
  ...props
}: NavLinkProps) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      className={cn(className, pendingClassName, isActive && activeClassName)}
      {...props}
    />
  );
}
