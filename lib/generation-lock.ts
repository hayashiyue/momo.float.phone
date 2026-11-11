// lib/generation-lock.ts
// 全局生成锁：标记「当前是否有一轮对话/剧情生成正在进行中」，
// 供记忆自动总结等后台任务在生成期间主动退避，避免和前台请求抢 API 配额、
// 也避免在生成中途读取尚未落地的时间线数据。
//
// 说明：当前仓库内只有 lib/memory-summarizer.ts 调用了 hasActiveGenerationLock()。
// 该文件此前遗漏提交，导致 Vercel（Linux 环境严格按路径查找）构建报
// "Cannot find module './generation-lock'"。这里补一份自洽的最小实现：
// 采用模块级计数，任何调用方都可以在生成开始时 beginGeneration()、
// 结束时 endGeneration()；在没有调用方获取锁的情况下恒为 false，
// 即行为等同于「永远不阻塞后台任务」，与缺失前的预期行为一致。

let activeGenerationCount = 0;

/** 获取生成锁（生成开始时调用，须与 endGeneration 成对出现）。 */
export function beginGeneration(): void {
    activeGenerationCount += 1;
}

/** 释放生成锁（生成结束时调用，幂等，最小值收敛到 0）。 */
export function endGeneration(): void {
    activeGenerationCount = Math.max(0, activeGenerationCount - 1);
}

/**
 * 是否有生成正在进行中。
 * 供后台任务（如记忆自动总结）判断是否需要退避。
 */
export function hasActiveGenerationLock(): boolean {
    return activeGenerationCount > 0;
}

/** 当前持有生成锁的数量，便于调试展示。 */
export function getActiveGenerationCount(): number {
    return activeGenerationCount;
}