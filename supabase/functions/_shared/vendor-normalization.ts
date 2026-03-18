export function normalizeVendorName(source: string): string {
  const cleaned = source
    // Quita codigos/numeros al inicio (comun en Days/Desesplast)
    .replace(/^\s*(?:nro\.?\s*)?\d[\d\-./]*\s*[:\-]?\s*/i, "")
    .replace(/^\s*[a-z]{1,3}\d+\s*[:\-]?\s*/i, "")
    // Quita CUITs/codigos incrustados
    .replace(/\b\d{2}-\d{8}-\d\b/g, "")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/\b(CUIT|COD)\b/gi, "")
    .replace(/^[\s,.-]+|[\s,.-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Si viene "APELLIDO, NOMBRE", invierte a "Nombre Apellido".
  if (cleaned.includes(",")) {
    const [lastName, firstName] = cleaned
      .split(",")
      .map((part) => part.replace(/^[\s,.-]+|[\s,.-]+$/g, "").trim());
    if (lastName && firstName) {
      return titleCase(`${firstName} ${lastName}`);
    }
  }

  const normalized = titleCase(cleaned);
  // Fallback para casos como "Apellido Nombre -" o "Apellido Nombre,"
  return normalized.replace(/[\s,.-]+$/g, "").trim();
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((token) => {
      const upperAcronyms = new Set(["sa", "srl", "sas", "s.a.", "s.r.l."]);
      if (upperAcronyms.has(token)) return token.toUpperCase().replaceAll(".", "");
      return `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
    })
    .join(" ")
    .trim();
}

export function pathSafeVendorName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}
