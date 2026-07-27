"use client";

import { useState } from "react";

import { PricingCard, UsageMeter } from "@/components/account";
import {
  AIResponseActions,
  CitationList,
  ContextSourcePanel,
} from "@/components/ai";
import { DailyBriefCard } from "@/components/dashboard";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Toast,
} from "@/components/feedback";
import { Icon } from "@/components/icons";
import { KnowledgeFileRow, KnowledgePreview } from "@/components/knowledge";
import { MemoryCard, MemorySourceBadge } from "@/components/memory";
import { ConfirmationDialog, Drawer, Modal } from "@/components/overlay";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  IconButton,
  Input,
  Select,
  Switch,
  Tabs,
  Tag,
} from "@/components/primitives";
import { SearchCommand } from "@/components/search";
import {
  AIAssistantPanel,
  SidebarNavigation,
  TopCommandBar,
} from "@/components/shell";
import {
  AgentBadge,
  WorkflowCard,
  WorkflowStatusBadge,
  WorkflowTimeline,
  WORKFLOW_STATUSES,
} from "@/components/workflow";

/**
 * 组件走查页 —— 仅开发环境可访问,用于核对移植后的组件与设计系统是否一致。
 *
 * 这里的内容是明确标注的走查样本,不是产品数据。产品页面接入真实数据在 Phase 7,
 * 在此之前任何产品页面都不得出现此类内容。
 */

function Row({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className="border-border-default bg-surface-2 rounded-card border p-5">
      <h2 className="text-fg-tertiary text-label mb-4">{title}</h2>
      <div className={className ?? "flex flex-wrap items-center gap-3"}>
        {children}
      </div>
    </section>
  );
}

export default function GalleryPage() {
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState("a");
  const [text, setText] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-12">
      <header className="mb-2">
        <h1 className="text-h2 text-fg font-semibold">组件走查</h1>
        <p className="text-fg-secondary text-body mt-2">
          38 个设计系统组件的移植结果。此页仅开发环境可见,生产构建返回 404。
        </p>
      </header>

      <Row title="Button · 四种变体">
        <Button variant="primary">主要操作</Button>
        <Button variant="secondary">次要操作</Button>
        <Button variant="ghost">幽灵按钮</Button>
        <Button variant="danger">删除</Button>
        <Button disabled>已禁用</Button>
        <Button loading>载入中</Button>
      </Row>

      <Row title="Button 尺寸 · IconButton">
        <Button size="sm">小</Button>
        <Button size="md">中</Button>
        <Button size="lg">大</Button>
        <IconButton aria-label="搜索">
          <Icon name="search" />
        </IconButton>
        <IconButton active aria-label="筛选">
          <Icon name="filter" />
        </IconButton>
      </Row>

      <Row title="Badge · Tag · Avatar · AgentBadge">
        <Badge>中性</Badge>
        <Badge tone="brand">品牌</Badge>
        <Badge tone="success">已完成</Badge>
        <Badge tone="warning">等待确认</Badge>
        <Badge tone="error">执行失败</Badge>
        <Badge tone="info">等待输入</Badge>
        <Tag>全部</Tag>
        <Tag active onClick={() => undefined}>
          进行中
        </Tag>
        <Avatar name="陈煜" />
        <AgentBadge name="研究" />
        <AgentBadge name="写作" role="长文" />
      </Row>

      <Row title="表单元件">
        <Input
          label="搜索"
          placeholder="搜索知识库"
          value={text}
          onChange={setText}
          className="w-56"
        />
        <Input label="错误态" placeholder="格式不正确" error className="w-40" />
        <Select
          value="all"
          options={[
            { value: "all", label: "全部工作流" },
            { value: "running", label: "正在运行" },
          ]}
        />
        <Checkbox checked={checked} onChange={setChecked} label="启用该记忆" />
        <Switch checked={on} onChange={setOn} label="允许 AI 调用" />
      </Row>

      <Row title="Tabs" className="block">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "a", label: "全部" },
            { value: "b", label: "待确认" },
            { value: "c", label: "已完成" },
          ]}
        />
      </Row>

      <Row title="WorkflowStatusBadge · 需求要求的 10 个状态">
        {WORKFLOW_STATUSES.map((status) => (
          <WorkflowStatusBadge key={status} status={status} />
        ))}
      </Row>

      <Row title="WorkflowCard" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <WorkflowCard
          name="走查样本 · 工作流卡片"
          goal="展示卡片在等待确认状态下的排版"
          status="WAITING_FOR_APPROVAL"
          currentStep="确认关键假设"
          agents={["研究", "写作"]}
          lastRun="09:41"
          onOpen={() => undefined}
        />
        <WorkflowCard
          name="走查样本 · 运行中"
          goal="展示活跃状态点的呼吸动效"
          status="RUNNING"
          currentStep="生成对比表"
          agents={["研究"]}
          lastRun="08:55"
        />
      </Row>

      <Row title="WorkflowTimeline" className="block">
        <WorkflowTimeline
          steps={[
            {
              id: "1",
              title: "收集数据",
              status: "COMPLETED",
              agent: "研究",
              timestamp: "09:12",
            },
            {
              id: "2",
              title: "生成初稿",
              status: "RUNNING",
              agent: "写作",
              timestamp: "09:38",
            },
            { id: "3", title: "等待确认", status: "WAITING_FOR_APPROVAL" },
            { id: "4", title: "导出文档", status: "DRAFT" },
          ]}
        />
      </Row>

      <Row title="MemorySourceBadge · 推断与确认必须可区分">
        <MemorySourceBadge source="inferred" />
        <MemorySourceBadge source="confirmed" />
        <MemorySourceBadge source="file" />
        <MemorySourceBadge source="workflow" />
      </Row>

      <Row title="MemoryCard" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <MemoryCard
          category="走查样本 · 写作风格"
          content="这是走查用的示例记忆内容,用于核对卡片排版与来源标识。"
          source="inferred"
          createdAt="2026-06-02"
          lastUsedAt="2 小时前"
          confidence={82}
          scope="全部工作流"
        />
        <MemoryCard
          category="走查样本 · 已确认事实"
          content="用户确认保存的记忆不显示置信度,与 AI 推断明确区分。"
          source="confirmed"
          createdAt="2026-05-11"
          lastUsedAt="昨天"
          scope="季度报告工作流"
        />
      </Row>

      <Row title="KnowledgeFileRow · 六种解析状态" className="block">
        <KnowledgeFileRow
          name="走查样本 · 可用.pdf"
          type="PDF"
          size="2.4 MB"
          status="ready"
          linkedWorkflows={3}
          tags={["财务"]}
        />
        <KnowledgeFileRow
          name="走查样本 · 上传中.docx"
          type="DOCX"
          size="1.1 MB"
          status="uploading"
        />
        <KnowledgeFileRow
          name="走查样本 · 解析中.md"
          type="MD"
          size="24 KB"
          status="parsing"
        />
        <KnowledgeFileRow
          name="走查样本 · 建索引.txt"
          type="TXT"
          size="8 KB"
          status="indexing"
        />
        <KnowledgeFileRow
          name="走查样本 · 解析失败.pdf"
          type="PDF"
          size="5.2 MB"
          status="failed"
        />
        <KnowledgeFileRow
          name="走查样本 · 不支持.xyz"
          type="XYZ"
          size="12 KB"
          status="unsupported"
        />
      </Row>

      <Row title="KnowledgePreview · 唯一的浅色纸张画布" className="block">
        <KnowledgePreview title="走查样本 · 文档阅读面" updatedAt="今天 14:20">
          正文宽度受 --reading-measure
          约束,不做通栏。浅色纸张画布只在文档阅读场景出现,并且始终嵌套在深色应用框架内部。
        </KnowledgePreview>
      </Row>

      <Row
        title="AI 上下文与引用"
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
      >
        <ContextSourcePanel
          workflow="走查样本 · 季度经营分析"
          knowledgeRefs={["走查样本 · 财务附表.pdf"]}
          memoryRefs={["走查样本 · 写作风格偏好"]}
        />
        <CitationList
          citations={[
            {
              id: "c1",
              title: "走查样本 · 引用条目一",
              snippet: "引用必须指向真实检索到的来源。",
            },
            { id: "c2", title: "走查样本 · 引用条目二" },
          ]}
        />
      </Row>

      <Row title="AIResponseActions · 未接通能力显示为不可用">
        <AIResponseActions disabledActions={["export", "createTask"]} />
      </Row>

      <Row title="UsageMeter" className="flex w-full flex-col gap-4">
        <UsageMeter label="AI 调用次数" used={6200} total={10000} unit=" 次" />
        <UsageMeter label="存储空间" used={9600} total={10000} unit=" MB" />
      </Row>

      <Row title="PricingCard">
        <PricingCard
          name="Free"
          price="¥0"
          period="月"
          features={["基础工作流", "1 GB 存储"]}
        />
        <PricingCard
          name="Professional"
          price="¥99"
          period="月"
          features={["全部工作流", "50 GB 存储", "高级模型"]}
          highlighted
          ctaDisabled
          ctaDisabledReason="支付未接通,当前不可升级"
        />
      </Row>

      <Row
        title="EmptyState / ErrorState / LoadingState"
        className="grid grid-cols-1 gap-4 md:grid-cols-3"
      >
        <EmptyState
          title="还没有知识文件"
          description="上传文档,AI 才能引用它们。"
          actionLabel="上传文件"
        />
        <ErrorState
          description="解析服务暂时不可用,稍后可重试。"
          onRetry={() => undefined}
        />
        <LoadingState />
      </Row>

      <Row title="Toast">
        <Toast tone="info" message="走查样本 · 信息提示" onClose={() => undefined} />
        <Toast tone="success" message="走查样本 · 操作成功" />
        <Toast tone="warning" message="走查样本 · 额度即将用尽" />
        <Toast tone="error" message="走查样本 · 执行失败" />
      </Row>

      <Row title="浮层 · 点击打开,Esc 或点遮罩关闭">
        <Button variant="secondary" onClick={() => setModalOpen(true)}>
          Modal
        </Button>
        <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
          Drawer
        </Button>
        <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
          ConfirmationDialog
        </Button>
        <Button variant="secondary" onClick={() => setSearchOpen(true)}>
          SearchCommand
        </Button>
      </Row>

      <Row title="DailyBriefCard" className="block">
        <DailyBriefCard
          date="2026年7月27日 周一"
          greeting="走查样本 · 今日摘要"
          priorities={["这是走查用的优先事项示例", "第二条优先事项"]}
          runningWorkflows={[
            { id: "w1", name: "走查样本 · 分析报告", status: "RUNNING" },
            { id: "w2", name: "走查样本 · 竞品简报", status: "QUEUED" },
          ]}
          pendingConfirmations={["走查样本 · 初稿待确认"]}
        />
      </Row>

      <Row title="Shell 构件" className="block">
        <div className="border-border-default rounded-card h-125 overflow-hidden border">
          <div className="flex h-full">
            <SidebarNavigation activeKey="workflow" />
            <div className="flex min-w-0 flex-1 flex-col">
              <TopCommandBar title="走查样本 · 工作流" />
              <div className="text-fg-tertiary text-caption flex-1 p-6">
                左侧导航未传 account 时如实显示「未登录」,不使用占位账户数据。
              </div>
            </div>
            <AIAssistantPanel
              contextLabel="走查样本 · 当前上下文"
              messages={[
                {
                  id: "m1",
                  role: "assistant",
                  text: "这是走查用的助手消息气泡。",
                },
                { id: "m2", role: "user", text: "这是用户消息气泡。" },
              ]}
              suggestions={["走查样本 · 推荐操作"]}
              disabled
              disabledReason="模型服务未接通,输入已禁用"
            />
          </div>
        </div>
      </Row>

      <Modal
        open={modalOpen}
        title="走查样本 · 对话框"
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              取消
            </Button>
            <Button onClick={() => setModalOpen(false)}>确认</Button>
          </>
        }
      >
        支持 Esc 关闭、打开时焦点移入、关闭后焦点归还。
      </Modal>

      <Drawer
        open={drawerOpen}
        title="走查样本 · 抽屉"
        onClose={() => setDrawerOpen(false)}
      >
        <p className="text-fg-secondary text-caption">从右侧滑出的面板。</p>
      </Drawer>

      <ConfirmationDialog
        open={confirmOpen}
        title="删除这条记忆?"
        description="删除后无法恢复,相关工作流将失去这条记忆。"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => setConfirmOpen(false)}
      />

      <SearchCommand
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        results={[
          {
            id: "r1",
            title: "走查样本 · 搜索结果",
            category: "知识库",
            icon: "knowledge",
          },
          {
            id: "r2",
            title: "走查样本 · 工作流结果",
            category: "工作流",
            icon: "workflow",
          },
        ]}
      />
    </main>
  );
}
