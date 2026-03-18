"use client";

import { ChevronDown, LogOut, UserCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { signOut } from "@/modules/auth/services/auth-client-service";

type TopBarProps = {
  email: string;
};

export function TopBar({ email }: TopBarProps) {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleSignOut = async () => {
    setIsLoading(true);
    const { error } = await signOut();
    setIsLoading(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    toast.success("Sesion cerrada.");
    router.refresh();
    router.push("/auth");
  };

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <SidebarTrigger />
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex h-7 items-center gap-2 rounded-md border px-2 text-sm">
          <UserCircle className="size-4" />
          <span className="max-w-56 truncate">{email}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Sesion activa</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleSignOut}
            disabled={isLoading}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="size-4" />
            Cerrar sesion
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
