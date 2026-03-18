"use client";

import JSZip from "jszip";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type PortalResponse = {
  vendorName: string;
  files: Array<{ name: string; signedUrl: string }>;
};

export default function VendorPortalPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const query = useQuery({
    queryKey: ["vendor-portal", token],
    queryFn: async (): Promise<PortalResponse> => {
      const response = await fetch(`/api/portal/${token}`);
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? "No se pudo cargar el portal.");
      }
      return response.json() as Promise<PortalResponse>;
    },
  });

  const downloadAll = async () => {
    if (!query.data?.files.length) return;
    const zip = new JSZip();
    for (const file of query.data.files) {
      const response = await fetch(file.signedUrl);
      const blob = await response.blob();
      zip.file(file.name, blob);
    }
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${query.data.vendorName}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (query.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="mx-auto max-w-3xl p-4 md:p-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="size-5 text-destructive" /> Error
            </CardTitle>
          </CardHeader>
          <CardContent>{query.error.message}</CardContent>
        </Card>
      </div>
    );
  }

  const files = query.data?.files ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold">{query.data?.vendorName}</h1>
      {!files.length ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No hay archivos disponibles para descargar.
          </CardContent>
        </Card>
      ) : (
        <>
          <Button onClick={downloadAll}>
            <Download className="size-4" />
            Descargar Todo
          </Button>
          <div className="space-y-2">
            {files.map((file) => (
              <Card key={file.name}>
                <CardContent className="flex items-center justify-between py-4">
                  <span className="text-sm">{file.name}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      window.open(file.signedUrl, "_blank", "noopener,noreferrer");
                      toast.success("Descarga iniciada.");
                    }}
                  >
                    Descargar
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Este enlace es personal. No lo compartas con terceros.
      </p>
    </div>
  );
}
