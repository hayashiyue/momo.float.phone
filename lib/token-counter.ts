// lib/token-counter.ts
// Lightweight token estimation — zero external dependencies.
// CJK characters ~ 1.5 char/token, Latin ~ 4 char/token, +4 overhead per message.

// 统计中日韩字符数：用 charCodeAt 逐码位判断，等价于原正则
// /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g
// 的匹配结果，但零内存分配。
// 原实现用 text.match(...) 统计，会为文中每个中日韩字符新建一个单字符串对象并塞进数组：
// prepareShortTermContext 每轮要对几百条时间线事件与历史消息各算一次 token，
// 总量可达几十万个瞬时对象，直接把 JSC 的垃圾回收顶成主线程停顿。
export function estimateTokens(text: string): number {
    if (!text) return 0;
    let cjkCount = 0;
    for (let i = 0, len = text.length; i < len; i += 1) {
        const code = text.charCodeAt(i);
        if (
            (code >= 0x2E80 && code <= 0x9FFF)
            || (code >= 0xF900 && code <= 0xFAFF)
            || (code >= 0xFE30 && code <= 0xFE4F)
            || (code >= 0x3000 && code <= 0x30FF)
            || (code >= 0xAC00 && code <= 0xD7AF)
        ) {
            cjkCount += 1;
        }
    }
    const latinCount = text.length - cjkCount;
    return Math.ceil(cjkCount / 1.5 + latinCount / 4);
}

export function estimateMessagesTokens(messages: { role: string; content: string }[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokens(msg.content) + 4; // per-message overhead
    }
    return total + 2; // conversation overhead
}

export function remainingTokenBudget(
    maxContext: number,
    currentTokens: number,
    reserveForGeneration: number = 500
): number {
    return Math.max(0, maxContext - currentTokens - reserveForGeneration);
}
