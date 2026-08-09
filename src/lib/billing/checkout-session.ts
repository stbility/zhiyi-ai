import "server-only";

import { getStripe } from "@/lib/billing/stripe";
import { logger } from "@/lib/log";

/**
 * 付款回跳后的「正在开通」判定。
 *
 * 为什么需要它:Checkout 的 success_url 是
 * `/billing?session_id={CHECKOUT_SESSION_ID}`,浏览器跳回来通常比 Stripe
 * 把 webhook 送到我们这里更快。而 /billing 只读数据库,于是用户**刚付完钱**
 * 看到的是「当前为免费套餐(未订阅付费套餐)」——在整条闭环里,这是最伤的
 * 一个瞬间:钱扣了,产品说你没买。
 *
 * 这里做的事只有一件:向 Stripe 确认这次结账真的付掉了,好让页面把话说对
 * ——「支付已收到,正在开通」。
 *
 * **它不写任何东西,也不解锁任何东西。**
 * subscriptions 的唯一写者仍然是 webhook(0033 的写者纪律),权益仍然只来自
 * get_entitlements。URL 上的 session_id 不构成授权:
 *
 *   · session_id 是不可猜的 Stripe 标识,但我们不靠「猜不到」来防
 *   · 必须 metadata.userId === 当前登录用户,别人的 session id 一律不认
 *   · 即使认了,也只是把一句文案从「未订阅」换成「正在开通」
 *
 * 所以最坏情况是有人让自己的页面多显示一行「正在开通」,拿不到任何权益。
 */

/** 这次回跳是否对应一笔**已付款、且属于当前用户**的结账。 */
export async function isActivationPending(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  // 形状先过一道:Checkout Session id 一律 cs_ 开头,别的直接不查,
  // 免得把任意字符串丢给 Stripe。
  if (!sessionId.startsWith("cs_") || sessionId.length > 200) return false;

  const stripe = getStripe();
  if (!stripe) return false;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // 归属校验:这次结账必须是**这个登录用户**发起的。
    // metadata.userId 由服务端 checkout 路由写入,客户端改不了。
    if (session.metadata?.["userId"] !== userId) {
      logger.warn(
        { sessionId, userId },
        "billing 回跳:session 不属于当前用户,忽略",
      );
      return false;
    }

    return session.payment_status === "paid" || session.status === "complete";
  } catch (e) {
    // 查不到就当没有 —— 页面照常按数据库显示,绝不因为这一步失败而报错。
    logger.warn(
      { sessionId, error: e instanceof Error ? e.message : String(e) },
      "billing 回跳:读取 checkout session 失败",
    );
    return false;
  }
}
