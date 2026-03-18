import { AlertTriangle } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ServiceUnavailable() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto rounded-full bg-destructive/10 p-3 text-destructive">
            <AlertTriangle className="size-6" />
          </div>
          <CardTitle className="text-2xl">503 Service Unavailable</CardTitle>
        </CardHeader>
        <CardContent className="text-center text-muted-foreground">
          El sistema está temporalmente deshabilitado por mantenimiento.
        </CardContent>
      </Card>
    </div>
  );
}
