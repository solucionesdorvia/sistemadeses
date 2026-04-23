/**
 * Requiere en Azure: app registration + permiso de aplicación
 * "Files.ReadWrite.All" (consentimiento de administrador) o delegado
 * con cuenta de servicio. El usuario/identificador indica en qué OneDrive
 * se sube el .xlsx temporal (se elimina luego de obtener el PDF).
 */
export type MicrosoftGraphPdfConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Object ID de usuario o UPN (ej. pdf-service@tudominio.com) cuyo OneDrive recibe temp files */
  userIdOrUpn: string;
  /** Carpeta bajo /drive/root/ (creada al subir el primer archivo) */
  tempFolder: string;
};

const TEMP_DEFAULT = "SistemadesesPdfTemp";

export function getMicrosoftGraphPdfConfig(): MicrosoftGraphPdfConfig | null {
  const tenantId = process.env.MICROSOFT_TENANT_ID?.trim();
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  const userIdOrUpn = process.env.MICROSOFT_GRAPH_USER_ID?.trim();
  if (!tenantId || !clientId || !clientSecret || !userIdOrUpn) {
    return null;
  }
  return {
    tenantId,
    clientId,
    clientSecret,
    userIdOrUpn,
    tempFolder: (process.env.MICROSOFT_PDF_TEMP_FOLDER?.trim() || TEMP_DEFAULT).replace(
      /^\/+|\/+$/g,
      "",
    ),
  };
}
