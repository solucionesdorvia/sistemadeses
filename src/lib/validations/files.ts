import { z } from "zod";

export const uploadCuentaCorrienteSchema = z.object({
  companyType: z.enum(["americana", "days", "desesplast"]),
  files: z.array(z.instanceof(File)).min(1, "Debes seleccionar al menos un archivo."),
});

export const uploadBoletasSchema = z.object({
  files: z
    .array(z.instanceof(File))
    .min(1, "Debes seleccionar al menos un PDF.")
    .refine((files) => files.every((file) => file.type === "application/pdf"), {
      message: "Solo se permiten PDFs.",
    }),
});
