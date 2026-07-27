"use client";

import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";

import { Modal } from "./Modal";

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string | undefined;
  onConfirm?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel = "确认删除",
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-2.5">
        <Icon name="alert" size={18} className="text-error mt-0.5 shrink-0" />
        <span>{description}</span>
      </div>
    </Modal>
  );
}
