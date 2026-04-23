/**
 * Misma lógica que al escribir en `results/.../vendedores/{carpeta}/` en
 * `process` y en Edge. Usar con `vendors.normalized_name` (igual que al generar
 * el path al procesar), no con `canonical_name` (puede formatear distinto y
 * resolverse a otra carpeta en storage).
 */
export function pathSafeVendorName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}
