import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { getRequestUserId } from "../_shared/auth.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const userId = await getRequestUserId(request);
    const basePath = `${userId}/vendedores`;

    const folders = await listAllObjects("results", basePath);
    const folderNames = folders
      .map((entry) => entry.name)
      .filter((name) => name && name !== ".emptyFolderPlaceholder");

    const nestedLists = await runWithConcurrency(folderNames, 12, async (folder) => {
      const folderPath = `${basePath}/${folder}`;
      const files = await listAllObjects("results", folderPath);
      return files.map((file) => ({ folder, name: file.name }));
    });

    const toDelete = nestedLists
      .flat()
      .filter((entry) => entry.name && entry.name !== ".emptyFolderPlaceholder")
      .map((entry) => `${basePath}/${entry.folder}/${entry.name}`);

    const batches = chunkArray(toDelete, 250);
    await runWithConcurrency(batches, 6, async (batch) => {
      if (batch.length === 0) return;
      const removed = await supabase.storage.from("results").remove(batch);
      if (removed.error) throw new Error(removed.error.message);
    });

    // Conserva visibilidad de carpetas vacias en dashboard de Storage.
    await runWithConcurrency(folderNames, 12, async (folder) => {
      const placeholderPath = `${basePath}/${folder}/.emptyFolderPlaceholder`;
      const uploaded = await supabase.storage
        .from("results")
        .upload(placeholderPath, new Blob([""]), {
          upsert: true,
          contentType: "text/plain",
        });
      if (uploaded.error) throw new Error(uploaded.error.message);
    });

    return new Response(
      JSON.stringify({
        ok: true,
        deletedCount: toDelete.length,
        folderCount: folderNames.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        message:
          error instanceof Error
            ? error.message
            : "No se pudieron limpiar los archivos de vendedores.",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

type ListedItem = { name: string };

async function listAllObjects(bucket: string, prefix: string): Promise<ListedItem[]> {
  const all: ListedItem[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const listed = await supabase.storage.from(bucket).list(prefix, {
      limit,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (listed.error) throw new Error(listed.error.message);
    const page = listed.data ?? [];
    all.push(...page.map((item) => ({ name: item.name })));
    if (page.length < limit) break;
    offset += limit;
  }

  return all;
}

function chunkArray<T>(source: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < source.length; i += size) {
    chunks.push(source.slice(i, i + size));
  }
  return chunks;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  if (items.length === 0) return [] as R[];
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: safeConcurrency }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) break;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}
