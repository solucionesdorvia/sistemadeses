import type { Vendor } from "@/lib/types/domain";
import type { VendorRow } from "@/lib/types/database";

export function mapVendorRow(row: VendorRow): Vendor {
  return {
    id: row.id,
    userId: row.user_id,
    normalizedName: row.normalized_name,
    originalName: row.original_name,
    canonicalName: row.canonical_name,
    companyType: row.company_type,
    email: row.email,
    driveFolderId: row.drive_folder_id,
    convertToPdf: row.convert_to_pdf,
    accessToken: row.access_token,
    vendorNumber: row.vendor_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
