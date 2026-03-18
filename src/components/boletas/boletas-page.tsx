"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BoletasByVendor } from "@/components/boletas/boletas-by-vendor";
import { BoletasHistory } from "@/components/boletas/boletas-history";
import { BoletasUpload } from "@/components/boletas/boletas-upload";
import { VendorsConfig } from "@/components/boletas/vendors-config";

export function BoletasPage() {
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Boletas</h1>
        <p className="text-sm text-muted-foreground">
          Carga, analisis, agrupacion y distribucion de boletas por vendedor.
        </p>
      </div>

      <Tabs defaultValue="upload" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 lg:grid-cols-4">
          <TabsTrigger value="upload">Subir Boletas</TabsTrigger>
          <TabsTrigger value="history">Historial</TabsTrigger>
          <TabsTrigger value="by-vendor">Por Vendedor</TabsTrigger>
          <TabsTrigger value="config">Configuracion</TabsTrigger>
        </TabsList>
        <TabsContent value="upload">
          <BoletasUpload />
        </TabsContent>
        <TabsContent value="history">
          <BoletasHistory />
        </TabsContent>
        <TabsContent value="by-vendor">
          <BoletasByVendor />
        </TabsContent>
        <TabsContent value="config">
          <VendorsConfig />
        </TabsContent>
      </Tabs>
    </section>
  );
}
