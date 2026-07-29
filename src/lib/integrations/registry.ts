/**
 * 集成注册表。
 *
 * 智能体要能干活,就得能调外部服务。这里定义有哪些集成、各自需要什么凭据、
 * 以及怎么验证它真的通了。
 *
 * 与模型服务商分开:模型是「用什么说话」,集成是「能调用什么能力」。
 * 混在一起,后面每加一种集成都要改模型逻辑。
 *
 * 新增一种集成只需在这里加一条 + 写它的适配器,不改任何调用方 ——
 * 这是「不写死、可扩展」的落点。
 */

export type IntegrationKind = "tavily";

export interface IntegrationSpec {
  readonly kind: IntegrationKind;
  readonly label: string;
  /** 这个集成给智能体带来什么能力,用于界面说明 */
  readonly capability: string;
  /** 凭据长什么样,帮用户确认自己粘对了 */
  readonly credentialHint: string;
  /** 申请密钥的官方地址 */
  readonly docsUrl: string;
}

export const INTEGRATIONS: readonly IntegrationSpec[] = [
  {
    kind: "tavily",
    label: "Tavily 搜索",
    capability: "让智能体能联网检索最新资讯,并在回答里附上来源链接",
    credentialHint: "以 tvly- 开头",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  },
];

export function getIntegrationSpec(kind: string): IntegrationSpec | null {
  return INTEGRATIONS.find((i) => i.kind === kind) ?? null;
}
