"use client";

import { useState } from "react";

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

/**
 * 组件走查页 —— 仅供开发期视觉核对移植后的组件是否与设计系统一致。
 * 不是产品页面,不接入任何业务数据。
 */

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-border-default bg-surface-2 rounded-card border p-5">
      <h2 className="text-fg-tertiary text-label mb-4">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export default function GalleryPage() {
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState("a");
  const [text, setText] = useState("");

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-6 py-12">
      <h1 className="text-h2 text-fg mb-4 font-semibold">组件走查 · 基础元件</h1>

      <Row title="Button · 四种变体">
        <Button variant="primary">主要操作</Button>
        <Button variant="secondary">次要操作</Button>
        <Button variant="ghost">幽灵按钮</Button>
        <Button variant="danger">删除</Button>
        <Button variant="primary" disabled>
          已禁用
        </Button>
        <Button variant="primary" loading>
          载入中
        </Button>
      </Row>

      <Row title="Button · 三种尺寸">
        <Button size="sm">小</Button>
        <Button size="md">中</Button>
        <Button size="lg">大</Button>
      </Row>

      <Row title="IconButton">
        <IconButton aria-label="示例">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </IconButton>
        <IconButton active aria-label="选中态">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </IconButton>
      </Row>

      <Row title="Badge · 六种语义">
        <Badge>中性</Badge>
        <Badge tone="brand">品牌</Badge>
        <Badge tone="success">已完成</Badge>
        <Badge tone="warning">等待确认</Badge>
        <Badge tone="error">执行失败</Badge>
        <Badge tone="info">等待输入</Badge>
      </Row>

      <Row title="Tag">
        <Tag>全部</Tag>
        <Tag active onClick={() => undefined}>
          进行中
        </Tag>
        <Tag onClick={() => undefined}>已归档</Tag>
      </Row>

      <Row title="Avatar">
        <Avatar name="陈煜" />
        <Avatar name="王婷" size={40} />
        <Avatar name="李" size={24} />
      </Row>

      <Row title="Input">
        <Input
          label="示例输入框"
          placeholder="搜索知识库"
          value={text}
          onChange={setText}
          className="w-64"
        />
        <Input label="错误态" placeholder="格式不正确" error className="w-48" />
        <Input label="禁用态" placeholder="不可编辑" disabled className="w-48" />
      </Row>

      <Row title="Select">
        <Select
          value="all"
          options={[
            { value: "all", label: "全部工作流" },
            { value: "running", label: "正在运行" },
          ]}
        />
      </Row>

      <Row title="Checkbox / Switch">
        <Checkbox checked={checked} onChange={setChecked} label="启用该记忆" />
        <Checkbox checked={false} label="已禁用" disabled />
        <Switch checked={on} onChange={setOn} label="允许 AI 调用" />
        <Switch checked={false} label="禁用态" disabled />
      </Row>

      <section className="border-border-default bg-surface-2 rounded-card border p-5">
        <h2 className="text-fg-tertiary text-label mb-4">Tabs</h2>
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "a", label: "全部" },
            { value: "b", label: "待确认" },
            { value: "c", label: "已完成" },
          ]}
        />
      </section>
    </main>
  );
}
