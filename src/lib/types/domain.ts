import type { COMPANY_TYPES, FILE_STATUSES } from "@/lib/config/app";

export type CompanyType = (typeof COMPANY_TYPES)[number];
export type FileStatus = (typeof FILE_STATUSES)[number];
export type ModuleType = "cuentas_corrientes" | "fichadas" | "boletas";

export type Vendor = {
  id: string;
  userId: string;
  normalizedName: string;
  originalName: string | null;
  canonicalName: string | null;
  companyType: CompanyType | null;
  email: string | null;
  driveFolderId: string | null;
  convertToPdf: boolean;
  accessToken: string | null;
  vendorNumber: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FileRecord = {
  id: string;
  userId: string;
  module: ModuleType;
  companyType: CompanyType | null;
  status: FileStatus;
  filePath: string;
  vendorFolderPath: string | null;
  vendorsFoundCount: number;
  boletaVendorNumber?: string | null;
  createdAt: string;
  updatedAt: string;
};
