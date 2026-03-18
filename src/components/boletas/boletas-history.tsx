"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { listBoletasFilesAction } from "@/lib/server-actions/files-actions";
import { downloadUploadedFile } from "@/modules/vendors/services/files-client-service";

export function BoletasHistory() {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["boletas-files"],
    queryFn: listBoletasFilesAction,
    refetchInterval: 5000,
  });

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando historial...</p>;
  }

  if (!query.data?.length) {
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground">
        Aun no hay boletas procesadas.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {query.data.map((file) => (
        <Card key={file.id}>
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div>
              <p className="font-medium">{file.filePath.split("/").pop()}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(file.createdAt).toLocaleString("es-AR")}
              </p>
              <p className="text-xs text-muted-foreground">
                Vendedor detectado: {file.boletaVendorNumber ?? "No detectado"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={downloadingId === file.id}
                onClick={async () => {
                  try {
                    setDownloadingId(file.id);
                    await downloadUploadedFile(file.filePath);
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : "No se pudo descargar la boleta.",
                    );
                  } finally {
                    setDownloadingId(null);
                  }
                }}
              >
                {downloadingId === file.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                Descargar
              </Button>
              <StatusBadge status={file.status} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
