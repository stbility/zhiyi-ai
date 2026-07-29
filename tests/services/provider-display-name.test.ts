import { describe, expect, it } from "vitest";

import {
  displayNameForBaseUrl,
  domainLabel,
} from "@/lib/providers/display-name";

/**
 * 服务商显示名测试。
 *
 * 真实故障:模型选择器显示成「integrate · z-ai/glm-5.2」。
 * 「integrate」是 integrate.api.nvidia.com 的子域名 —— 早先的命名逻辑
 * 取主机名第一段,对 api.deepseek.com 恰好正确,对英伟达就取错了。
 *
 * 这里的每个地址都取自 registry 的预设或各家官方文档,不是编造的。
 */

describe("域名主体提取", () => {
  it("跳过子域名与公共后缀,取到真正的域名主体", () => {
    expect(domainLabel("integrate.api.nvidia.com")).toBe("nvidia");
    expect(domainLabel("api.deepseek.com")).toBe("deepseek");
    expect(domainLabel("open.bigmodel.cn")).toBe("bigmodel");
    expect(domainLabel("api.moonshot.cn")).toBe("moonshot");
    expect(domainLabel("openrouter.ai")).toBe("openrouter");
    expect(domainLabel("ark.cn-beijing.volces.com")).toBe("volces");
  });

  it("处理二级后缀,不把 com 当成域名主体", () => {
    expect(domainLabel("api.example.com.cn")).toBe("example");
    expect(domainLabel("gateway.acme.co.uk")).toBe("acme");
  });

  it("本机与内网主机名原样使用", () => {
    expect(domainLabel("localhost")).toBe("localhost");
  });
});

describe("显示名", () => {
  it("预设命中时用官方正式名称,比域名好读", () => {
    expect(displayNameForBaseUrl("https://integrate.api.nvidia.com/v1")).toBe(
      "NVIDIA NIM",
    );
    expect(displayNameForBaseUrl("https://api.deepseek.com/v1")).toBe(
      "DeepSeek",
    );
    expect(displayNameForBaseUrl("https://api.moonshot.cn/v1")).toBe(
      "Moonshot Kimi",
    );
  });

  it("未收录的服务商也能得到像样的名字 —— 预设不是接入的前提", () => {
    expect(displayNameForBaseUrl("https://api.brand-new-ai.com/v1")).toBe(
      "brand-new-ai",
    );
    expect(displayNameForBaseUrl("https://llm.mycompany.internal/v1")).toBe(
      "mycompany",
    );
  });

  it("地址不合法时返回 null,由调用方兜底", () => {
    expect(displayNameForBaseUrl("not-a-url")).toBeNull();
  });
});
