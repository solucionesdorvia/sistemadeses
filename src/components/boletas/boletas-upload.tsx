"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { FileUpload } from "@/components/file-upload";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { uploadBoletasFiles } from "@/modules/vendors/services/files-client-service";

export function BoletasUpload() {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!files.length) throw new Error("Selecciona al menos un PDF.");
      // 1 archivo por request: PDFs pesados con regex pueden tardar
      // varios segundos cada uno, y un chunk grande corta la conexion
      // del browser (HTTP 499 si excede ~13s).
      const batches = chunk(files, 1);
      for (let i = 0; i < batches.length; i += 1) {
        await uploadBoletasFiles(batches[i]);
        setProgress(Math.round(((i + 1) / batches.length) * 100));
      }
    },
    onSuccess: async () => {
      setFiles([]);
      setProgress(100);
      toast.success("Boletas enviadas a procesamiento.");
      await queryClient.invalidateQueries({ queryKey: ["boletas-files"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-4">
      <FileUpload
        accept=".pdf"
        onFileSelect={setFiles}
        multiple
        maxSize={10 * 1024 * 1024}
        disabled={mutation.isPending}
      />
      <Progress value={progress} />
      <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
        Procesar boletas
      </Button>
    </div>
  );
}

function chunk<T>(source: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < source.length; i += size) {
    chunks.push(source.slice(i, i + size));
  }
  return chunks;
}
