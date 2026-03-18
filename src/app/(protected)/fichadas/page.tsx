import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function FichadasPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Fichadas</h1>
      <Tabs defaultValue="upload" className="space-y-4">
        <TabsList>
          <TabsTrigger value="upload">Subir Registros</TabsTrigger>
          <TabsTrigger value="reports">Reportes</TabsTrigger>
        </TabsList>
        <TabsContent value="upload" className="text-muted-foreground">
          Funcionalidad en desarrollo.
        </TabsContent>
        <TabsContent value="reports" className="text-muted-foreground">
          No hay reportes generados aun.
        </TabsContent>
      </Tabs>
    </section>
  );
}
