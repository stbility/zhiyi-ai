import { CURRENT_PHASE, PHASE_STATUS } from "@/lib/phase";
import {
  getServiceAvailability,
  type ServiceStatus,
} from "@/lib/services/availability";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ServiceStatus, string> = {
  configured: "已配置",
  unconfigured: "未配置",
  incomplete: "配置不完整",
  invalid: "配置错误",
};

const STATUS_CLASS: Record<ServiceStatus, string> = {
  configured: "bg-success-tint text-success",
  unconfigured: "bg-surface-3 text-fg-tertiary",
  incomplete: "bg-warning-tint text-warning",
  // 填了但填错比没填更危险 —— 它会让人误以为已经接通,因此用错误色而非警告色
  invalid: "bg-error-tint text-error",
};

function StatusChip({ status }: { status: ServiceStatus }) {
  return (
    <span
      className={`rounded-tag text-label inline-flex items-center gap-1.5 px-2 py-0.5 font-medium ${STATUS_CLASS[status]}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function Page() {
  const services = getServiceAvailability();
  const configured = services.filter((s) => s.status === "configured").length;

  return (
    <main className="max-w-reading mx-auto w-full px-6 py-16">
      <header className="mb-10">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="bg-brand text-on-brand rounded-control flex size-7 items-center justify-center text-sm font-semibold">
            智
          </span>
          <span className="text-fg text-body font-semibold">智一 AI</span>
        </div>
        <h1 className="text-h2 text-fg font-semibold">系统配置状态</h1>
        <p className="text-body text-fg-secondary mt-3">
          当前处于 {CURRENT_PHASE.label}。
          {!CURRENT_PHASE.productCapabilitiesShipped &&
            "产品能力尚未实现,"}
          本页如实展示各外部服务的接入状态,不展示任何模拟数据。已配置 {configured}{" "}
          / {services.length} 项。
        </p>
      </header>

      {/* 逐阶段的真实状态。
          此前这里只有一句「当前处于 Phase 1」,而模型网关、智能体、工作区
          早已在生产上跑起来 —— 状态页仍显示「产品能力尚未实现」。
          低报和高报同样是不实:用户据此判断能不能用,低报会让他不去用
          本来可用的东西。所以逐条列,部分完成的必须写清缺什么。 */}
      <section className="rounded-card border-border-default bg-surface-2 mb-6 border p-5">
        <h2 className="text-fg text-body mb-3 font-medium">交付阶段</h2>
        <ul className="flex flex-col gap-2">
          {PHASE_STATUS.map((phase) => (
            <li key={phase.id} className="flex flex-wrap items-start gap-2">
              <span
                className={
                  phase.state === "done"
                    ? "text-success text-label shrink-0"
                    : phase.state === "partial"
                      ? "text-warning text-label shrink-0"
                      : "text-fg-tertiary text-label shrink-0"
                }
              >
                {phase.state === "done"
                  ? "已完成"
                  : phase.state === "partial"
                    ? "部分完成"
                    : "未开始"}
              </span>
              <span className="text-fg-secondary text-caption min-w-0 flex-1">
                {phase.label}
                {phase.missing && (
                  <span className="text-fg-tertiary text-label block">
                    {phase.missing}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <ul className="flex flex-col gap-2">
        {services.map((service) => (
          <li
            key={service.key}
            className="rounded-card border-border-default bg-surface-2 border p-5"
          >
            <div className="flex items-center justify-between gap-4">
              <span className="text-fg text-body">{service.label}</span>
              <StatusChip status={service.status} />
            </div>

            {service.issues.length > 0 && (
              <ul className="border-error-tint bg-error-tint rounded-control mt-3 flex flex-col gap-2 p-3">
                {service.issues.map((issue) => (
                  <li key={issue.message}>
                    <p className="text-error text-caption">{issue.message}</p>
                    <p className="text-fg-tertiary text-label mt-1">
                      修正方式:{issue.fix}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {service.missing.length > 0 && (
              <div className="mt-3 flex flex-col gap-1.5">
                <p className="text-caption text-fg-tertiary">缺少环境变量</p>
                <div className="flex flex-wrap gap-1.5">
                  {service.missing.map((name) => (
                    <code
                      key={name}
                      className="rounded-tag bg-surface-3 text-fg-secondary text-label px-1.5 py-0.5 font-mono"
                    >
                      {name}
                    </code>
                  ))}
                </div>
                <p className="text-caption text-fg-tertiary mt-1">
                  未配置时不可用:{service.blocks.join("、")}
                </p>
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="text-caption text-fg-tertiary mt-8">
        填写方式:复制 <code className="font-mono">.env.example</code> 为{" "}
        <code className="font-mono">.env.local</code>{" "}
        并填入真实值。密钥仅在服务端读取,不会进入浏览器产物。
      </p>
    </main>
  );
}
