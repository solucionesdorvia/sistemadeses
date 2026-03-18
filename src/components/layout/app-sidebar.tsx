"use client";

import {
  FileSpreadsheet,
  Fingerprint,
  Files,
  ShieldCheck,
} from "lucide-react";

import { NavLink } from "@/components/common/nav-link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CREATOR, APP_NAME, ROUTES } from "@/lib/config/app";

const navItems = [
  {
    title: "Cuentas Corrientes",
    href: ROUTES.cuentasCorrientes,
    icon: FileSpreadsheet,
  },
  {
    title: "Fichadas",
    href: ROUTES.fichadas,
    icon: Fingerprint,
  },
  {
    title: "Boletas",
    href: ROUTES.boletas,
    icon: Files,
  },
];

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="pt-4">
        <div className="flex items-center gap-2 px-2">
          <div className="rounded-md bg-sidebar-primary p-2 text-sidebar-primary-foreground">
            <ShieldCheck className="size-4" />
          </div>
          <div className="group-data-[collapsible=icon]:hidden">
            <p className="text-sm font-semibold">{APP_NAME}</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarMenu>
          {navItems.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                render={
                  <NavLink
                    href={item.href}
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    className="w-full"
                  >
                    <item.icon className="size-4" />
                    <span>{item.title}</span>
                  </NavLink>
                }
              />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter>
        <p className="px-2 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
          {APP_CREATOR}
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}
