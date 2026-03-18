import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    const supabase = createAdminClient();

    const vendorResult = await supabase
      .from("vendors")
      .select("id, user_id, normalized_name, canonical_name")
      .eq("access_token", token)
      .single();

    if (vendorResult.error || !vendorResult.data) {
      return NextResponse.json({ message: "Token invalido." }, { status: 404 });
    }

    const folderKey =
      (vendorResult.data.canonical_name ?? vendorResult.data.normalized_name)
        .toLowerCase()
        .replace(/\s+/g, "-");
    const basePath = `${vendorResult.data.user_id}/vendedores/${folderKey}`;

    const storageResult = await supabase.storage
      .from("results")
      .list(basePath, { limit: 1000, sortBy: { column: "name", order: "desc" } });

    if (storageResult.error) {
      return NextResponse.json({ message: storageResult.error.message }, { status: 500 });
    }

    const names = storageResult.data
      .filter((entry) => entry.name !== ".emptyFolderPlaceholder")
      .map((entry) => `${basePath}/${entry.name}`);

    const signedUrls =
      names.length > 0
        ? await supabase.storage.from("results").createSignedUrls(names, 60 * 10)
        : { data: [], error: null };

    if (signedUrls.error) {
      return NextResponse.json({ message: signedUrls.error.message }, { status: 500 });
    }

    return NextResponse.json({
      vendorName: vendorResult.data.canonical_name ?? vendorResult.data.normalized_name,
      files: signedUrls.data
        .filter((item) => Boolean(item.path && item.signedUrl))
        .map((item) => ({
          path: item.path as string,
          name: (item.path as string).split("/").pop(),
          signedUrl: item.signedUrl as string,
        })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Error inesperado al cargar portal.",
      },
      { status: 500 },
    );
  }
}
