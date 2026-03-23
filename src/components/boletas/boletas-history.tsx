"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { listBoletasFilesAction } from "@/lib/server-actions/files-actions";
import {
  clearAllBoletaFiles,
  downloadUploadedFile,
} from "@/modules/vendors/services/files-client-service";

export function BoletasHistory() {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["boletas-files"],
    queryFn: listBoletasFilesAction,
    refetchInterval: 5000,
  });

  const clearMutation = useMutation({
    mutationFn: clearAllBoletaFiles,
    onSuccess: (result) => {
      setIsClearDialogOpen(false);
      toast.success(`Se eliminaron ${result.deletedCount} boleta(s).`);
      queryClient.invalidateQueries({ queryKey: ["boletas-files"] });
      queryClient.invalidateQueries({ queryKey: ["boletas-by-vendor"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "No se pudo limpiar.");
    },
  });

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando historial...</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            queryClient.invalidateQueries({ queryKey: ["boletas-files"] })
          }
        >
          <RefreshCw className="size-4" />
          Actualizar
        </Button>
        <AlertDialog
          open={isClearDialogOpen}
          onOpenChange={(open) => {
            if (!clearMutation.isPending) setIsClearDialogOpen(open);
          }}
        >
          <AlertDialogTrigger
            render={<Button size="sm" variant="destructive" disabled={!query.data?.length} />}
          >
            <Trash2 className="size-4" />
            Limpiar Todo
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Limpiar todas las boletas</AlertDialogTitle>
              <AlertDialogDescription>
                Se eliminaran todas las boletas subidas, sus analisis y archivos
                en storage. Esta accion no se puede deshacer.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={clearMutation.isPending}>
                Cancelar
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => clearMutation.mutate()}
                disabled={clearMutation.isPending}
              >
                {clearMutation.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Limpiando...
                  </>
                ) : (
                  "Confirmar"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {!query.data?.length ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          Aun no hay boletas procesadas.
        </p>
      ) : (
        query.data.map((file) => (
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
        ))
      )}
    </div>
  );
}
