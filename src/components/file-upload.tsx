"use client";

import { FileUp, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type FileUploadProps = {
  onFileSelect: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  maxSize?: number;
  disabled?: boolean;
};

export function FileUpload({
  onFileSelect,
  accept,
  multiple = false,
  maxSize,
  disabled = false,
}: FileUploadProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const maxSizeText = useMemo(() => {
    if (!maxSize) return null;
    return `${(maxSize / 1024 / 1024).toFixed(0)} MB`;
  }, [maxSize]);

  const setFiles = (files: File[]) => {
    const normalized = maxSize
      ? files.filter((file) => file.size <= maxSize)
      : files;
    setSelectedFiles(normalized);
    onFileSelect(normalized);
  };

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    setFiles(Array.from(event.target.files));
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    setFiles(Array.from(event.dataTransfer.files));
  };

  const removeAt = (index: number) => {
    const next = selectedFiles.filter((_, currentIndex) => currentIndex !== index);
    setSelectedFiles(next);
    onFileSelect(next);
  };

  return (
    <div className="space-y-4">
      <Card
        className={cn(
          "cursor-pointer border-dashed p-8 text-center transition-colors",
          disabled && "cursor-not-allowed opacity-60",
        )}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        onClick={() => !disabled && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={onInputChange}
        />
        <FileUp className="mx-auto mb-3 size-8 text-muted-foreground" />
        <p className="text-sm font-medium">Arrastra archivos o haz click para seleccionar</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {accept ? `Formatos: ${accept}` : "Cualquier formato"}{" "}
          {maxSizeText ? `| Max: ${maxSizeText}` : ""}
        </p>
      </Card>

      {selectedFiles.length > 0 && (
        <div className="space-y-2">
          {selectedFiles.map((file, index) => (
            <div
              key={`${file.name}-${file.size}-${index}`}
              className="flex items-center justify-between rounded-md border p-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation();
                  removeAt(index);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
