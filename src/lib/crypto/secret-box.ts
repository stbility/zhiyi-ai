import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { getServerEnv } from "@/lib/env/server";

/**
 * 第三方 API 密钥的加密存储。
 *
 * 用 AES-256-GCM:
 *   - GCM 自带完整性校验,密文被篡改会在解密时直接失败,而不是解出一段垃圾。
 *     对密钥这类数据,「解出错的东西」比「解不出来」危险得多。
 *   - 每次加密生成独立的随机 IV,相同明文不会产生相同密文,
 *     否则攻击者能从数据库里看出哪些组织配了同一把密钥。
 *
 * 存储格式:v1.<iv>.<authTag>.<ciphertext>,全部 base64url。
 * 带版本前缀是为了将来换算法时能平滑迁移,不必猜历史数据是怎么加密的。
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM 推荐 96 位
const KEY_LENGTH = 32; // AES-256

export class EncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionUnavailableError";
  }
}

function getKey(): Buffer {
  const raw = getServerEnv().ENCRYPTION_KEY;
  if (!raw) {
    throw new EncryptionUnavailableError(
      "ENCRYPTION_KEY 未配置,无法加密或解密密钥。",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new EncryptionUnavailableError(
      `ENCRYPTION_KEY 解码后为 ${key.length} 字节,AES-256 需要 ${KEY_LENGTH} 字节。`,
    );
  }
  return key;
}

/** 加密是否可用。不可用时调用方应如实展示,不得静默明文存储。 */
export function isEncryptionAvailable(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const key = getKey();
  const parts = payload.split(".");

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new EncryptionUnavailableError("密文格式无法识别。");
  }

  const iv = Buffer.from(parts[1] as string, "base64url");
  const authTag = Buffer.from(parts[2] as string, "base64url");
  const ciphertext = Buffer.from(parts[3] as string, "base64url");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // 认证失败时 final() 会抛错 —— 说明密文或 authTag 被改过,绝不能返回结果
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * 密钥掩码,用于界面回显。
 * 只保留末 4 位便于用户辨认是哪一把,其余一律遮蔽。
 */
export function maskApiKey(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `••••••••${plaintext.slice(-4)}`;
}

