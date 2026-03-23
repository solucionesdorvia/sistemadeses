"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { listBoletasByVendorAction } from "@/lib/server-actions/files-actions";
import { listVendorsAction } from "@/lib/server-actions/vendors-actions";
import { sendVendorEmails } from "@/modules/vendors/services/integrations-client-service";

export function BoletasByVendor() {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();
  const vendorsQuery = useQuery({
    queryKey: ["vendors"],
    queryFn: listVendorsAction,
  });
  const boletasQuery = useQuery({
    queryKey: ["boletas-by-vendor"],
    queryFn: listBoletasByVendorAction,
  });

  const normalizeVendorNumber = (value: string | null | undefined) => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const explicitMatch = trimmed.match(/(?:vend(?:edor)?\.?\s*:?\s*)(\d{1,8})/i);
    if (explicitMatch?.[1]) {
      return explicitMatch[1].replace(/^0+/, "").trim() || "0";
    }
    const tokens = trimmed.match(/\d+/g) ?? [];
    if (tokens.length === 1) {
      return tokens[0].replace(/^0+/, "").trim() || "0";
    }
    const digitsOnly = trimmed.replace(/[^\d]/g, "");
    return digitsOnly ? digitsOnly.replace(/^0+/, "").trim() || "0" : null;
  };

  const counts = useMemo(() => {
    const byNumber = new Map<string, number>();
    const byVendorId = new Map<string, number>();

    for (const row of boletasQuery.data ?? []) {
      const vendor = row.vendor as { id?: string; vendor_number?: string | null } | null;
      const vendorId = vendor?.id ?? null;
      if (vendorId) {
        byVendorId.set(vendorId, (byVendorId.get(vendorId) ?? 0) + 1);
      }

      const number =
        normalizeVendorNumber((row.vendor_number as string | null) ?? null) ??
        normalizeVendorNumber(vendor?.vendor_number ?? null) ??
        "";
      if (!number) continue;
      byNumber.set(number, (byNumber.get(number) ?? 0) + 1);
    }

    return { byNumber, byVendorId };
  }, [boletasQuery.data]);

  const filtered = useMemo(
    () =>
      (vendorsQuery.data ?? []).filter((vendor) => {
        const text = `${vendor.normalizedName} ${vendor.vendorNumber ?? ""}`.toLowerCase();
        const normalizedVendorNumber = normalizeVendorNumber(vendor.vendorNumber);
        const hasByVendorId = counts.byVendorId.has(vendor.id);
        const hasByNumber = normalizedVendorNumber
          ? counts.byNumber.has(normalizedVendorNumber)
          : false;
        return (
          text.includes(search.toLowerCase()) &&
          (hasByVendorId || hasByNumber)
        );
      }),
    [vendorsQuery.data, search, counts],
  );

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          placeholder="Buscar por vendedor o numero..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ["boletas-by-vendor"] });
            queryClient.invalidateQueries({ queryKey: ["vendors"] });
          }}
        >
          <RefreshCw className="size-4" />
          Actualizar
        </Button>
      </div>
      {!filtered.length ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          No hay vendedores con boletas asociadas.
        </p>
      ) : (
        filtered.map((vendor) => (
          <Card key={vendor.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              {(() => {
                const normalizedVendorNumber = normalizeVendorNumber(vendor.vendorNumber);
                const countByVendorId = counts.byVendorId.get(vendor.id) ?? 0;
                const countByNumber = normalizedVendorNumber
                  ? counts.byNumber.get(normalizedVendorNumber) ?? 0
                  : 0;
                const totalCount = Math.max(countByVendorId, countByNumber);

                return (
              <div>
                <p className="font-medium">{vendor.normalizedName}</p>
                <p className="text-xs text-muted-foreground">
                  Numero: {vendor.vendorNumber ?? "No definido"} | Email:{" "}
                  {vendor.email ?? "Sin email"} | Boletas: {totalCount}
                </p>
              </div>
                );
              })()}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      await sendVendorEmails({
                        module: "boletas",
                        specificVendor: vendor.normalizedName,
                      });
                      toast.success("Email enviado.");
                    } catch (error) {
                      toast.error(
                        error instanceof Error ? error.message : "No se pudo enviar email.",
                      );
                    }
                  }}
                >
                  <Mail className="size-4" />
                  Enviar
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
