"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  ChevronDown,
  Download,
  Loader2,
  Mail,
  RefreshCcw,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { FileUpload } from "@/components/file-upload";
import { GoogleDriveConnect } from "@/components/cuentas-corrientes/google-drive-connect";
import { VendorAliases } from "@/components/cuentas-corrientes/vendor-aliases";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";
import { ENABLE_GOOGLE_DRIVE } from "@/lib/config/app";
import { listCuentaCorrienteFilesAction } from "@/lib/server-actions/files-actions";
import {
  listVendorsAction,
} from "@/lib/server-actions/vendors-actions";
import { type CompanyType, type FileRecord } from "@/lib/types/domain";
import { uploadCuentaCorrienteFiles } from "@/modules/vendors/services/files-client-service";
import {
  clearAllVendorResultFiles,
  downloadResultFile,
  downloadVendorZip,
  listVendorResultFiles,
  triggerPdfConversion,
} from "@/modules/vendors/services/files-client-service";
import {
  type SendVendorEmailsResponse,
  sendVendorEmails,
  syncGoogleDrive,
} from "@/modules/vendors/services/integrations-client-service";

export function CuentasCorrientesPage() {
  const queryClient = useQueryClient();
  const [companyType, setCompanyType] = useState<CompanyType>("americana");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadInputKey, setUploadInputKey] = useState(0);
  const [uploadJobs, setUploadJobs] = useState<
    Array<{
      id: string;
      companyType: CompanyType;
      fileNames: string[];
      status: "processing" | "completed" | "error";
      createdAt: number;
      errorMessage?: string;
    }>
  >([]);
  const [search, setSearch] = useState("");
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);

  const filesQuery = useQuery({
    queryKey: ["cuentas-corrientes-files"],
    queryFn: listCuentaCorrienteFilesAction,
  });
  const vendorsQuery = useQuery({
    queryKey: ["vendors"],
    queryFn: listVendorsAction,
  });

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("files-cuentas-corrientes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "files" },
        async () => {
          await queryClient.invalidateQueries({ queryKey: ["cuentas-corrientes-files"] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const startUploadBatch = () => {
    if (!selectedFiles.length) {
      toast.error("Selecciona al menos un archivo.");
      return;
    }

    const batchFiles = [...selectedFiles];
    const batchCompany = companyType;
    const jobId = crypto.randomUUID();
    setSelectedFiles([]);
    setUploadInputKey((current) => current + 1);
    setUploadJobs((current) => [
      {
        id: jobId,
        companyType: batchCompany,
        fileNames: batchFiles.map((file) => file.name),
        status: "processing",
        createdAt: Date.now(),
      },
      ...current,
    ]);

    void (async () => {
      try {
        await uploadCuentaCorrienteFiles(batchFiles, batchCompany);
        setUploadJobs((current) =>
          current.map((job) => (job.id === jobId ? { ...job, status: "completed" } : job)),
        );
        toast.success(`Procesamiento iniciado para ${batchCompany}.`);
        await queryClient.invalidateQueries({ queryKey: ["cuentas-corrientes-files"] });
      } catch (error) {
        setUploadJobs((current) =>
          current.map((job) =>
            job.id === jobId
              ? {
                  ...job,
                  status: "error",
                  errorMessage:
                    error instanceof Error ? error.message : "No se pudo procesar el lote.",
                }
              : job,
          ),
        );
        toast.error(error instanceof Error ? error.message : "No se pudo procesar el lote.");
      }
    })();
  };

  const sendAllMutation = useMutation({
    mutationFn: async () => sendVendorEmails({ module: "cuentas_corrientes", sendAll: true }),
    onSuccess: (result: SendVendorEmailsResponse) => {
      const failed = (result.results ?? []).filter((item) => !item.sent);
      if (failed.length === 0) {
        toast.success(`Envio global ejecutado (${result.results?.length ?? 0} vendedor(es)).`);
        return;
      }

      const failedNames = failed.map((item) => item.vendor).join(", ");
      toast.error(`Fallido (${failed.length}): ${failedNames}`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const syncAllMutation = useMutation({
    mutationFn: async () => syncGoogleDrive(),
    onSuccess: () => toast.success("Sync global ejecutado."),
    onError: (error: Error) => toast.error(error.message),
  });

  const groupedVendors = useMemo(() => {
    const vendors = vendorsQuery.data ?? [];
    const uniqueByNormalizedName = new Map<string, (typeof vendors)[number]>();

    for (const vendor of vendors) {
      const key = vendor.normalizedName.trim().toLowerCase();
      const current = uniqueByNormalizedName.get(key);
      if (!current) {
        uniqueByNormalizedName.set(key, vendor);
        continue;
      }

      // Conserva el registro más completo para mostrar en la tarjeta.
      const currentScore =
        Number(Boolean(current.canonicalName)) +
        Number(Boolean(current.email)) +
        Number(Boolean(current.driveFolderId));
      const nextScore =
        Number(Boolean(vendor.canonicalName)) +
        Number(Boolean(vendor.email)) +
        Number(Boolean(vendor.driveFolderId));

      if (nextScore > currentScore) {
        uniqueByNormalizedName.set(key, vendor);
      }
    }

    return [...uniqueByNormalizedName.values()].filter((vendor) =>
      vendor.normalizedName.toLowerCase().includes(search.toLowerCase()),
    );
  }, [vendorsQuery.data, search]);

  const clearAllMutation = useMutation({
    mutationFn: clearAllVendorResultFiles,
    onSuccess: async (result) => {
      setIsClearDialogOpen(false);
      toast.success(`Se borraron ${result.deletedCount} archivo(s).`);
      await queryClient.invalidateQueries({ queryKey: ["cuentas-corrientes-files"] });
      await queryClient.invalidateQueries({ queryKey: ["vendors"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <section className="space-y-7">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Cuentas Corrientes</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          Procesa archivos por empresa, gestiona vendedores y distribuye resultados.
        </p>
      </div>

      <Tabs defaultValue="upload" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 lg:grid-cols-5">
          <TabsTrigger value="upload">Subir Archivos</TabsTrigger>
          <TabsTrigger value="by-vendor">Archivos por Vendedor</TabsTrigger>
          <TabsTrigger value="config">Configurar</TabsTrigger>
          <TabsTrigger value="alias">Alias</TabsTrigger>
          <TabsTrigger value="history">Historial</TabsTrigger>
        </TabsList>

        <TabsContent value="upload">
          <Card>
            <CardHeader>
              <CardTitle>Subir archivo maestro</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select
                value={companyType}
                onValueChange={(value) => setCompanyType(value as CompanyType)}
              >
                <SelectTrigger className="max-w-xs">
                  <SelectValue placeholder="Selecciona empresa" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="americana">Americana</SelectItem>
                  <SelectItem value="days">Days</SelectItem>
                  <SelectItem value="desesplast">Desesplast</SelectItem>
                </SelectContent>
              </Select>
              <FileUpload
                key={uploadInputKey}
                accept=".xlsx,.xls"
                onFileSelect={setSelectedFiles}
              />
              <Button onClick={startUploadBatch} disabled={selectedFiles.length === 0}>
                Procesar {companyType}
              </Button>
              {uploadJobs.length > 0 ? (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Lotes enviados (puedes seguir cargando otras empresas)
                  </p>
                  {uploadJobs.slice(0, 6).map((job) => (
                    <div
                      key={job.id}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium capitalize">
                          {job.companyType} - {job.fileNames.length} archivo(s)
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {job.fileNames.join(", ")}
                        </p>
                      </div>
                      <UploadJobStatusLabel job={job} />
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="by-vendor" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Buscar vendedor..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="max-w-sm"
            />
            <Button variant="outline" onClick={() => sendAllMutation.mutate()}>
              <Mail className="size-4" /> Enviar Todos
            </Button>
            {ENABLE_GOOGLE_DRIVE ? (
              <Button variant="outline" onClick={() => syncAllMutation.mutate()}>
                <RefreshCcw className="size-4" /> Sync Drive
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: ["cuentas-corrientes-files"] })
              }
            >
              Actualizar
            </Button>
            <AlertDialog
              open={isClearDialogOpen}
              onOpenChange={(open) => {
                if (!clearAllMutation.isPending) {
                  setIsClearDialogOpen(open);
                }
              }}
            >
              <AlertDialogTrigger render={<Button variant="destructive" />}>
                Limpiar Todo
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Limpiar archivos de vendedores</AlertDialogTitle>
                  <AlertDialogDescription>
                    Se eliminaran todos los archivos dentro de las carpetas de vendedores.
                    Las carpetas se conservaran.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={clearAllMutation.isPending}>
                    Cancelar
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => clearAllMutation.mutate()}
                    disabled={clearAllMutation.isPending}
                  >
                    {clearAllMutation.isPending ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Limpiando...
                      </>
                    ) : (
                      "Confirmar limpieza"
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="space-y-2">
            {vendorsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando vendedores...</p>
            ) : groupedVendors.length === 0 ? (
              <p className="rounded-md border p-4 text-sm text-muted-foreground">
                No hay vendedores para mostrar.
              </p>
            ) : (
              groupedVendors.map((vendor) => (
                <Collapsible key={vendor.id} className="rounded-md border">
                  <CollapsibleTrigger className="flex w-full items-center justify-between p-3 text-left">
                    <div>
                      <p className="font-medium">{vendor.canonicalName ?? vendor.normalizedName}</p>
                      <p className="text-xs text-muted-foreground">
                        {vendor.email ?? "Sin email configurado"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <ChevronDown className="size-4 text-muted-foreground" />
                      <Button size="icon" variant="ghost">
                        <UserPlus className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            const files = await listVendorResultFiles(
                              vendor.canonicalName ?? vendor.normalizedName,
                            );
                            await downloadVendorZip(
                              files.map((file) => file.path),
                              vendor.canonicalName ?? vendor.normalizedName,
                            );
                          } catch (error) {
                            toast.error(
                              error instanceof Error
                                ? error.message
                                : "Error al descargar ZIP.",
                            );
                          }
                        }}
                      >
                        <Archive className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            const response = await sendVendorEmails({
                              module: "cuentas_corrientes",
                              specificVendor: vendor.normalizedName,
                            });
                            const failed = (response.results ?? []).find((item) => !item.sent);
                            if (failed) {
                              toast.error(
                                `Fallido: ${failed.vendor}${failed.reason ? ` - ${failed.reason}` : ""}`,
                              );
                            } else {
                              toast.success("Email enviado.");
                            }
                          } catch (error) {
                            toast.error(
                              error instanceof Error ? error.message : "Error al enviar email.",
                            );
                          }
                        }}
                      >
                        <Mail className="size-4" />
                      </Button>
                      {ENABLE_GOOGLE_DRIVE ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Sync Drive vendedor"
                          onClick={async () => {
                            try {
                              await syncGoogleDrive(vendor.normalizedName);
                              toast.success("Sync de Drive ejecutado para vendedor.");
                            } catch (error) {
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : "Error al sincronizar Drive del vendedor.",
                              );
                            }
                          }}
                        >
                          <RefreshCcw className="size-4" />
                        </Button>
                      ) : null}
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Generar PDF vendedor"
                        onClick={async () => {
                          try {
                            const response = await triggerPdfConversion({
                              vendorName: vendor.normalizedName,
                            });
                            if (response.converted > 0) {
                              toast.success(`PDF generado (${response.converted}).`);
                            } else if (response.errors.length > 0) {
                              toast.error(
                                `Fallido: ${response.errors[0]?.vendor} - ${response.errors[0]?.reason ?? "Error"}`,
                              );
                            } else {
                              toast.error("No se encontraron archivos para convertir.");
                            }
                          } catch (error) {
                            toast.error(
                              error instanceof Error
                                ? error.message
                                : "Error al generar PDF del vendedor.",
                            );
                          }
                        }}
                      >
                        <Archive className="size-4" />
                      </Button>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="border-t p-3">
                    <VendorFilesList
                      vendorName={vendor.canonicalName ?? vendor.normalizedName}
                    />
                  </CollapsibleContent>
                </Collapsible>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="config" className="space-y-4">
          {ENABLE_GOOGLE_DRIVE ? (
            <GoogleDriveConnect />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Google Drive</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Integracion desactivada temporalmente. El procesamiento de archivos
                funciona sin Google Drive.
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Configuracion de vendedores</CardTitle>
            </CardHeader>
            <CardContent>
              {vendorsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Cargando...</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Vendedor</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Carpeta Drive</TableHead>
                      <TableHead>PDF</TableHead>
                      <TableHead>Acciones</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(vendorsQuery.data ?? []).map((vendor) => (
                      <VendorConfigRow
                        key={vendor.id}
                        vendor={vendor}
                        onUpdated={async () => {
                          await queryClient.invalidateQueries({ queryKey: ["vendors"] });
                        }}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="alias">
          <VendorAliases />
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Historial de procesamiento</CardTitle>
            </CardHeader>
            <CardContent>
              <HistoryTable data={filesQuery.data ?? []} loading={filesQuery.isLoading} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </section>
  );
}

function UploadJobStatusLabel({
  job,
}: {
  job: {
    status: "processing" | "completed" | "error";
    errorMessage?: string;
  };
}) {
  if (job.status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-blue-600">
        <Loader2 className="size-3 animate-spin" />
        Procesando
      </span>
    );
  }

  if (job.status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
        <CheckCircle2 className="size-3" />
        Enviado
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-red-600"
      title={job.errorMessage ?? "Error al procesar"}
    >
      <AlertCircle className="size-3" />
      Error
    </span>
  );
}

function VendorFilesList({ vendorName }: { vendorName: string }) {
  const query = useQuery({
    queryKey: ["vendor-result-files", vendorName],
    queryFn: () => listVendorResultFiles(vendorName),
  });

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando archivos...</p>;
  }

  if (!query.data?.length) {
    return <p className="text-sm text-muted-foreground">No hay archivos en esta carpeta.</p>;
  }

  return (
    <div className="space-y-2">
      {query.data.map((file) => (
        <div
          key={file.path}
          className="flex items-center justify-between rounded-md border px-3 py-2"
        >
          <span className="text-sm">{file.name}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void downloadResultFile(file.path)}
          >
            <Download className="size-4" />
            Descargar
          </Button>
        </div>
      ))}
    </div>
  );
}

function HistoryTable({ data, loading }: { data: FileRecord[]; loading: boolean }) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">Cargando historial...</p>;
  }

  if (!data.length) {
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground">
        No hay registros de procesamiento aun.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Archivo</TableHead>
          <TableHead>Empresa</TableHead>
          <TableHead>Vendedores</TableHead>
          <TableHead>Estado</TableHead>
          <TableHead>Fecha</TableHead>
          <TableHead>Acciones</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((file) => (
          <TableRow key={file.id}>
            <TableCell className="font-medium">{file.filePath.split("/").pop()}</TableCell>
            <TableCell className="capitalize">{file.companyType ?? "-"}</TableCell>
            <TableCell>{file.vendorsFoundCount ?? 0}</TableCell>
            <TableCell>
              <StatusBadge status={file.status} />
            </TableCell>
            <TableCell>{new Date(file.createdAt).toLocaleString("es-AR")}</TableCell>
            <TableCell>
              <Button size="sm" variant="outline" disabled={file.status !== "completed"}>
                <Download className="size-4" />
                JSON
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function VendorConfigRow({
  vendor,
  onUpdated,
}: {
  vendor: Awaited<ReturnType<typeof listVendorsAction>>[number];
  onUpdated: () => Promise<void>;
}) {
  const [email, setEmail] = useState(vendor.email ?? "");
  const [driveFolderId, setDriveFolderId] = useState(vendor.driveFolderId ?? "");
  const [convertToPdf, setConvertToPdf] = useState(vendor.convertToPdf);

  return (
    <TableRow>
      <TableCell>{vendor.normalizedName}</TableCell>
      <TableCell>
        <Input value={email} onChange={(event) => setEmail(event.target.value)} />
      </TableCell>
      <TableCell>
        <Input
          value={driveFolderId}
          onChange={(event) => setDriveFolderId(event.target.value)}
        />
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          <Select
            value={convertToPdf ? "true" : "false"}
            onValueChange={(value) => setConvertToPdf(value === "true")}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="false">No</SelectItem>
              <SelectItem value="true">Si</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">Actual: {convertToPdf ? "Si" : "No"}</p>
        </div>
      </TableCell>
      <TableCell>
        <Button
          size="sm"
          onClick={async () => {
            try {
              const supabase = createClient();
              const update = await supabase
                .from("vendors")
                .update({
                  email: email.trim() || null,
                  drive_folder_id: driveFolderId.trim() || null,
                  convert_to_pdf: convertToPdf,
                })
                .eq("id", vendor.id);

              if (update.error) {
                throw new Error(update.error.message);
              }
              toast.success("Configuracion guardada.");
              await onUpdated();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Error al guardar.");
            }
          }}
        >
          Guardar
        </Button>
      </TableCell>
    </TableRow>
  );
}
