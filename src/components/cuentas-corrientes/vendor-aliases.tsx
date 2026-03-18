"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { listVendorsAction } from "@/lib/server-actions/vendors-actions";

export function VendorAliases() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [canonicalName, setCanonicalName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const vendorsQuery = useQuery({
    queryKey: ["vendors"],
    queryFn: listVendorsAction,
  });

  const filtered = useMemo(() => {
    const all = vendorsQuery.data ?? [];
    if (!search) return all;
    return all.filter((vendor) =>
      vendor.normalizedName.toLowerCase().includes(search.toLowerCase()),
    );
  }, [vendorsQuery.data, search]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (selected.length < 2) throw new Error("Selecciona al menos 2 vendedores.");
      if (!canonicalName.trim()) throw new Error("Completa el nombre canonico.");

      const supabase = createClient();
      const result = await supabase
        .from("vendors")
        .update({ canonical_name: canonicalName.trim() })
        .in("id", selected);

      if (result.error) throw new Error(result.error.message);
    },
    onSuccess: async () => {
      setCanonicalName("");
      setSelected([]);
      await queryClient.invalidateQueries({ queryKey: ["vendors"] });
      toast.success("Alias guardado.");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alias de vendedores</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input
          placeholder="Buscar vendedor..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
          {filtered.map((vendor) => (
            <label
              key={vendor.id}
              className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-muted"
            >
              <Checkbox
                checked={selected.includes(vendor.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked
                      ? [...current, vendor.id]
                      : current.filter((item) => item !== vendor.id),
                  )
                }
              />
              <span className="text-sm">
                {vendor.normalizedName}
                {vendor.canonicalName ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({vendor.canonicalName})
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Nombre canonico"
            value={canonicalName}
            onChange={(event) => setCanonicalName(event.target.value)}
          />
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            Guardar alias
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
