"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import {
  createOrganization,
  type CreateOrganizationState,
} from "@/app/(app)/today/actions";

/** 由中文名生成合法的 slug 备选:去掉非法字符,中文无法转写时留空让用户自填 */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function CreateOrganizationForm() {
  const [state, formAction, pending] = useActionState<
    CreateOrganizationState,
    FormData
  >(createOrganization, {});

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  function onNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(suggestSlug(value));
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Input
        name="name"
        label="组织名称"
        placeholder="例如:市场部"
        required
        maxLength={100}
        value={name}
        onChange={onNameChange}
      />

      <div className="flex flex-col gap-1.5">
        <Input
          name="slug"
          label="组织标识"
          placeholder="例如:marketing"
          required
          value={slug}
          onChange={(v) => {
            setSlugTouched(true);
            setSlug(v);
          }}
        />
        <p className="text-fg-tertiary font-zh text-label">
          仅小写字母、数字与连字符,长度 3–50。中文名称无法自动转写时请手动填写。
        </p>
      </div>

      {state.error && (
        <div
          role="alert"
          className="border-error-tint bg-error-tint rounded-control p-3"
        >
          <p className="text-error font-zh text-caption">{state.error}</p>
        </div>
      )}

      <Button type="submit" loading={pending} className="w-full sm:w-auto">
        {pending ? "创建中…" : "创建组织"}
      </Button>
    </form>
  );
}
