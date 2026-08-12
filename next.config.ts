import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // 知识库文件上传走 Server Action(FormData)。
    // Next.js 默认限制 server action 请求体 1MB,而知识库允许单文件最大
    // 10MB(KNOWLEDGE_UPLOAD_MAX_BYTES)—— 不放开的话超过 1MB 的文件
    // 直接在请求层被拒,永远到不了解析器,用户看到的就是「解析报错不工作」。
    // 12MB 覆盖 10MB 上限 + 表单字段余量。
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
