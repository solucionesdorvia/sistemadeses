"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Vendor } from "@/lib/types/domain";
import {
  createVendorAction,
  listVendorsAction,
  updateVendorConfigAction,
} from "@/lib/server-actions/vendors-actions";

export function VendorsConfig() {
  const queryClient = useQueryClient();
  const [vendorNumber, setVendorNumber] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const query = useQuery({ queryKey: ["vendors"], queryFn: listVendorsAction });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("El nombre es obligatorio.");
      await createVendorAction({
        normalizedName: name.trim(),
        vendorNumber: vendorNumber.trim() || null,
        email: email.trim() || null,
        companyType: null,
      });
    },
    onSuccess: async () => {
      setVendorNumber("");
      setName("");
      setEmail("");
      toast.success("Vendedor creado.");
      await queryClient.invalidateQueries({ queryKey: ["vendors"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-4">
        <Input
          placeholder="Numero vendedor"
          value={vendorNumber}
          onChange={(event) => setVendorNumber(event.target.value)}
        />
        <Input placeholder="Nombre" value={name} onChange={(event) => setName(event.target.value)} />
        <Input
          placeholder="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button onClick={() => createMutation.mutate()}>Crear vendedor</Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Numero</TableHead>
            <TableHead>Nombre</TableHead>
            <TableHead>Email</TableHead>
            <TableHead className="w-[140px]">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(query.data ?? []).map((vendor) => (
            <VendorEditableRow key={vendor.id} vendor={vendor} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function VendorEditableRow({ vendor }: { vendor: Vendor }) {
  const queryClient = useQueryClient();
  const [vendorNumber, setVendorNumber] = useState(vendor.vendorNumber ?? "");
  const [email, setEmail] = useState(vendor.email ?? "");

  const updateMutation = useMutation({
    mutationFn: async () => {
      await updateVendorConfigAction(vendor.id, {
        vendorNumber: vendorNumber.trim() || null,
        email: email.trim() || null,
        driveFolderId: vendor.driveFolderId ?? "",
        convertToPdf: vendor.convertToPdf,
      });
    },
    onSuccess: async () => {
      toast.success("Vendedor actualizado.");
      await queryClient.invalidateQueries({ queryKey: ["vendors"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <TableRow>
      <TableCell>
        <Input
          value={vendorNumber}
          placeholder="Numero vendedor"
          onChange={(event) => setVendorNumber(event.target.value)}
        />
      </TableCell>
      <TableCell>{vendor.normalizedName}</TableCell>
      <TableCell>
        <Input
          value={email}
          type="email"
          placeholder="Email"
          onChange={(event) => setEmail(event.target.value)}
        />
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          onClick={() => updateMutation.mutate()}
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? "Guardando..." : "Guardar"}
        </Button>
      </TableCell>
    </TableRow>
  );
}
