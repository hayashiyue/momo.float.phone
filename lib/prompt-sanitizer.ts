import { parseStateValues } from "./state-value-parser";

export function stripStateAndInnerForPrompt(text: string): string {
    if (!text) return "";
    // 状态栏 / 内心 / 状态值标记都以 "[" 开头。绝大多数普通消息不含 "["，
    // 直接压空行返回，省掉 parseStateValues 与三条跨行正则的全文扫描。
    if (!text.includes("[")) {
        return text.includes("\n\n\n") ? text.replace(/\n{3,}/g, "\n\n").trim() : text.trim();
    }
    const withoutState = parseStateValues(text).cleanText;
    return withoutState
        .replace(/\[状态栏\][\s\S]*?\[\/状态栏\]/g, "")
        .replace(/\[内心\][\s\S]*?\[\/内心\]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
