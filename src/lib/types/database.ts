import type { CompanyType, FileStatus, ModuleType } from "@/lib/types/domain";

export type VendorRow = {
  id: string;
  user_id: string;
  normalized_name: string;
  original_name: string | null;
  canonical_name: string | null;
  company_type: CompanyType | null;
  email: string | null;
  drive_folder_id: string | null;
  convert_to_pdf: boolean;
  access_token: string | null;
  vendor_number: string | null;
  created_at: string;
  updated_at: string;
};

export type FileRow = {
  id: string;
  user_id: string;
  module: ModuleType;
  company_type: CompanyType | null;
  status: FileStatus;
  file_path: string;
  vendor_folder_path: string | null;
  original_filename: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type BoletaAnalysisRow = {
  id: string;
  user_id: string;
  file_id: string;
  vendor_id: string | null;
  vendor_number: string | null;
  analysis_text: string | null;
  extracted_data: Record<string, unknown> | null;
  confidence_score: number | null;
  created_at: string;
  updated_at: string;
};
