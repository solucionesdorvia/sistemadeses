"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { disconnectGoogleDrive } from "@/modules/vendors/services/integrations-client-service";

export function GoogleDriveConnect() {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const loadState = async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setConnected(false);
        return;
      }

      const result = await supabase
        .from("google_oauth_tokens")
        .select("id")
        .eq("user_id", user.id)
        .limit(1);
      setConnected(Boolean(result.data && result.data.length > 0));
    };
    void loadState();
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === "google-oauth-success") {
        setConnected(true);
        toast.success("Google Drive conectado.");
      }
      if (event.data?.type === "google-oauth-error") {
        toast.error("No se pudo completar la conexion OAuth.");
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  const handleConnect = () => {
    void (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error("Sesion invalida o expirada. Inicia sesion nuevamente.");
        return;
      }

      setLoading(true);
      const response = await fetch("/api/google-oauth/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const start = (await response.json()) as { authUrl?: string; message?: string };
      setLoading(false);

      if (!response.ok || !start.authUrl) {
        toast.error(start.message ?? "No se pudo iniciar OAuth.");
        return;
      }

      const width = 600;
      const height = 720;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      window.open(
        start.authUrl,
        "google-oauth",
        `width=${width},height=${height},left=${left},top=${top}`,
      );
    })();
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await disconnectGoogleDrive();
      setConnected(false);
      toast.success("Google Drive desconectado.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Error desconocido al desconectar.";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Drive</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {connected
            ? "Tu cuenta esta conectada y lista para sincronizar."
            : "Conecta Google Drive para habilitar sincronizacion de carpetas."}
        </p>
        {connected ? (
          <Button variant="outline" onClick={handleDisconnect} disabled={loading}>
            Desconectar
          </Button>
        ) : (
          <Button onClick={handleConnect}>Conectar Google Drive</Button>
        )}
      </CardContent>
    </Card>
  );
}
