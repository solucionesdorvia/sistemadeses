import { z } from "zod";

export const vendorConfigSchema = z.object({
  email: z.email("Email inválido.").nullable().or(z.literal("")),
  driveFolderId: z.string().trim().nullable().or(z.literal("")),
  convertToPdf: z.boolean(),
  vendorNumber: z.string().trim().nullable().or(z.literal("")).optional(),
});

export const createVendorSchema = z.object({
  normalizedName: z
    .string()
    .trim()
    .min(2, "Nombre demasiado corto.")
    .max(120, "Nombre demasiado largo."),
  companyType: z.enum(["americana", "days", "desesplast"]).nullable(),
  vendorNumber: z.string().trim().nullable().or(z.literal("")),
  email: z.email("Email inválido.").nullable().or(z.literal("")),
});

export type VendorConfigSchema = z.infer<typeof vendorConfigSchema>;
export type CreateVendorSchema = z.infer<typeof createVendorSchema>;
