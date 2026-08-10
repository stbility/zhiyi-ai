#!/usr/bin/env node
/**
 * 回填旧记忆的向量(长期记忆激活后执行)。
 *
 * 0040 上线后,新沉淀的记忆在写入时异步生成 embedding;存量记忆的
 * embedding 列为 NULL,语义召回( search_memories )看不到它们 ——
 * 本脚本把它们全部补上。
 *
 * 幂等:只处理 embedding IS NULL 的行,可随时中断重跑。
 * 诚实:缺任一必需环境变量就拒绝执行并说明缺什么,绝不静默半跑。
 *
 * 用法:
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   NEXT_PUBLIC_SUPABASE_URL=... \
 *   EMBEDDINGS_API_URL=... EMBEDDINGS_API_KEY=... \
 *   node scripts/backfill-embeddings.mjs
 */

const REQUIRED_ENV = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "EMBEDDINGS_API_URL",
  "EMBEDDINGS_API_KEY",
];
const missing = REQUIRED_ENV.filter((k) => !(process.env[k] ?? "").trim());
if (missing.length > 0) {
  console.error(`缺少环境变量:${missing.join(", ")} —— 拒绝执行。`);
  process.exit(1);
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMBED_URL = process.env.EMBEDDINGS_API_URL;
const EMBED_KEY = process.env.EMBEDDINGS_API_KEY;
const EMBED_MODEL = process.env.EMBEDDINGS_MODEL?.trim() || "text-embedding-3-small";
const BATCH = 50; // 一次 embedding 请求的记忆条数
const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

function api(path) {
  return `${URL}/rest/v1/${path}`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** 批量生成向量;失败抛错(回填失败要看得见,不是悄悄跳过) */
async function embedBatch(texts) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${EMBED_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`embedding 服务 HTTP ${res.status}`);
  }
  const data = await res.json();
  const vectors = (data?.data ?? []).map((d) => d.embedding);
  if (vectors.length !== texts.length) {
    throw new Error(`embedding 返回数量不符:期望 ${texts.length},实际 ${vectors.length}`);
  }
  return vectors;
}

async function main() {
  let updated = 0;
  let skipped = 0;
  let rounds = 0;

  // 逐批取「没有向量」的记忆;一次 1000 条上限,游标分页
  // ⚠️ 排序键必须与游标键一致(order=id.asc + id gt. 游标):
  // 曾用 order=created_at.asc 而游标按 id —— UUID 与 created_at 无相关性,
  // 同刻并列/并发新记忆会被 id 过滤永久跳过 = 回填静默漏行。
  let cursor = null;
  while (true) {
    const params = new URLSearchParams({
      select: "id,content",
      "embedding": "is.null",
      order: "id.asc",
      limit: String(BATCH),
    });
    if (cursor) params.set("id", `gt.${cursor}`);

    let rows;
    try {
      rows = await fetchJson(`${api("memories")}?${params}`, { headers: HEADERS });
    } catch (e) {
      console.error(`读取记忆失败:${e.message}`);
      process.exit(1);
    }
    if (rows.length === 0) break;

    const texts = rows.map((r) => r.content ?? "");
    const vectors = await embedBatch(texts);

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const vector = vectors[i];
      // 内容为空或向量为空 → 跳过(记数,不写)
      if (!texts[i].trim() || !Array.isArray(vector) || vector.length === 0) {
        skipped += 1;
        continue;
      }
      try {
        await fetchJson(api(`memories?id=eq.${row.id}`), {
          method: "PATCH",
          headers: HEADERS,
          body: JSON.stringify({ embedding: vector }),
        });
        updated += 1;
      } catch (e) {
        console.error(`更新记忆 ${row.id} 失败:${e.message}`);
        process.exit(1);
      }
    }
    cursor = rows[rows.length - 1].id;
    rounds += 1;
    console.log(
      `第 ${rounds} 轮:本批 ${rows.length} 条,累计更新 ${updated} / 跳过 ${skipped} / 合计 ${updated + skipped}`,
    );
  }

  console.log(`\n回填完成:更新 ${updated} 条,跳过 ${skipped} 条。`);
  if (updated > 0) {
    console.log("这些记忆现在会出现在 search_memories 的语义召回里。");
  }
}

main().catch((e) => {
  console.error(`回填失败:${e.message}`);
  process.exit(1);
});
