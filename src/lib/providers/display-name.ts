import { COMPATIBLE_PRESETS } from "@/lib/providers/registry";

/**
 * 由接口地址推导服务商的显示名。
 *
 * 之前的写法是「取主机名第一段」,对 api.deepseek.com 恰好正确(deepseek),
 * 对 integrate.api.nvidia.com 就取成了子域名 —— 于是模型选择器里显示成
 * 「integrate · z-ai/glm-5.2」,用户完全看不出这是英伟达。
 *
 * 现在分两步:
 *   1. 先在预设里按主机名精确匹配,命中就用预设的正式名称(NVIDIA NIM、
 *      DeepSeek、智谱 GLM…)。预设本来就是为「省去查文档」准备的,
 *      顺带解决命名再合适不过。
 *   2. 没命中就退回域名推导,但取的是**注册域主体**而不是第一段,
 *      并跳过 .com.cn / .co.uk 这类二级后缀。
 *
 * 第 2 步保证新服务商无需改代码也能得到一个像样的名字 —— 预设只是让已知的
 * 那些更好看,不是接入的前提。
 */

/** 需要跳过的公共后缀,避免把 com / co 当成域名主体 */
const PUBLIC_SUFFIXES = new Set([
  "com", "net", "org", "io", "ai", "co", "cn", "dev", "app", "cloud", "xyz",
  // 内网/自建部署常见的后缀 —— 公司内网网关也该得到像样的名字
  "internal", "local", "lan", "corp", "intranet",
]);

/** 无意义的主机名前缀,单独出现时不能作为名称 */
const NOISE_LABELS = new Set([
  "www", "api", "open", "integrate", "openapi", "gateway", "inference",
]);

/** 从主机名里取出可读的域名主体 */
export function domainLabel(hostname: string): string | null {
  const labels = hostname.split(".").filter((l) => l !== "");
  if (labels.length === 0) return null;
  // localhost、内网主机名这类没有点的,原样用
  if (labels.length === 1) return labels[0] ?? null;

  // 从右往左跳过公共后缀,剩下的第一个就是域名主体。
  // integrate.api.nvidia.com → 跳过 com → nvidia
  // api.example.com.cn       → 跳过 cn、com → example
  // 国家/地区后缀太多,不逐个枚举 —— 末尾长度 ≤2 的一律当作 ccTLD
  // (uk / jp / de / cn / us …),配合上面的公共后缀表就够用了。
  const isSuffix = (label: string) =>
    PUBLIC_SUFFIXES.has(label) || label.length <= 2;

  let i = labels.length - 1;
  while (i > 0 && isSuffix(labels[i] as string)) i -= 1;

  const main = labels[i] as string;
  // 万一域名主体本身就是噪声词(极少见),往左再取一个
  if (NOISE_LABELS.has(main) && i > 0) return labels[i - 1] as string;
  return main;
}

/**
 * 由接口地址得出显示名。取不到时返回 null,由调用方决定兜底。
 */
export function displayNameForBaseUrl(baseUrl: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return null;
  }

  // 预设命中优先 —— 用官方正式名称,比域名好读
  const preset = COMPATIBLE_PRESETS.find((p) => {
    try {
      return new URL(p.baseUrl).hostname === hostname;
    } catch {
      return false;
    }
  });
  if (preset) return preset.label;

  return domainLabel(hostname);
}
