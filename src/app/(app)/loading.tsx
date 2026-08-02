/**
 * 应用区的加载骨架。
 *
 * 存在的理由:这些页面是 force-dynamic,一次要跑好几个数据库查询。
 * 没有 loading 边界时,点了导航之后 Next.js 会**停在旧页面**等服务端返回 ——
 * 屏幕一两秒毫无变化,用户理所当然认为没点上,于是反复点。
 *
 * 有了它,点击那一刻立刻切到骨架:反馈是即时的,等待是可见的。
 * 这比把查询优化快 200 毫秒有用得多 —— 用户受不了的是「没反应」,
 * 不是「慢」。
 */
export default function AppLoading() {
  return (
    <div
      className="font-zh flex w-full flex-col gap-4 px-4 py-6 md:px-8 md:py-10"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">正在加载</span>

      {/* 标题占位 */}
      <div className="bg-surface-3 rounded-control h-6 w-40 animate-pulse" />

      {/* 内容占位。三块不等宽,比一整块灰条更像真实内容,
          也不会让人误以为页面已经加载完但空了 */}
      <div className="flex flex-col gap-3">
        {[100, 92, 76].map((w) => (
          <div
            key={w}
            className="bg-surface-2 rounded-card h-24 animate-pulse"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    </div>
  );
}
