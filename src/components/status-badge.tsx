import { Badge } from "@/components/ui/badge";
import type { FileStatus } from "@/lib/types/domain";

const labels: Record<FileStatus, string> = {
  pending: "Pendiente",
  processing: "Procesando",
  completed: "Completado",
  error: "Error",
};

const classes: Record<FileStatus, string> = {
  pending: "bg-amber-100 text-amber-800 hover:bg-amber-100",
  processing: "bg-cyan-100 text-cyan-800 hover:bg-cyan-100",
  completed: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
  error: "bg-rose-100 text-rose-800 hover:bg-rose-100",
};

export function StatusBadge({ status }: { status: FileStatus }) {
  return <Badge className={classes[status]}>{labels[status]}</Badge>;
}
