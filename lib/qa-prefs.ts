// ── 工坊可调偏好（叶子模块，避免循环依赖）─────────────
// kv-db 只依赖 dexie，不反向依赖本文件，引入它不会成环。
// 这三个键原先只写裸 localStorage：既没有主模块归属（会被数据管理里
// 「缓存与未分类数据」整类扫走清理），也没有 IndexedDB 副本可恢复，
// 于是用户设好的值在清缓存 / 存储压力回收 / 恢复不含缓存的备份后会悄悄
// 退回默认。现在统一注册进 kv-db，registerKvMigration 顺带迁移旧值。
import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";

/** 偏好读取：kv 优先，localStorage 兜底（兼容尚未迁移的旧值）。 */
function readPref(key: string): string | null {
    const cached = kvGet(key);
    if (cached !== null) return cached;
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/** 偏好写入：null = 恢复默认（删除该键）。 */
function writePref(key: string, value: string | null): void {
    if (value === null) kvRemove(key);
    else kvSet(key, value);
}

// 单页读取字符数：答疑文档翻页、本机内容/创作指南翻页、仓库文件单次读取共用。
// kv 键 ai_phone_qa_page_chars 覆盖（调参/测试用）。
export const QA_DEFAULT_PAGE_CHARS = 90_000;
export const QA_PAGE_CHARS_MIN = 2_000;
export const QA_PAGE_CHARS_MAX = 100_000;

const QA_PAGE_CHARS_KEY = "ai_phone_qa_page_chars";
registerKvMigration(QA_PAGE_CHARS_KEY);

export function getQaPageChars(): number {
    const raw = Number(readPref(QA_PAGE_CHARS_KEY));
    if (Number.isFinite(raw) && raw >= QA_PAGE_CHARS_MIN && raw <= QA_PAGE_CHARS_MAX) return Math.floor(raw);
    return QA_DEFAULT_PAGE_CHARS;
}

/** 设置单页读取字符数（null = 恢复默认） */
export function setQaPageChars(chars: number | null): void {
    if (chars == null) writePref(QA_PAGE_CHARS_KEY, null);
    else {
        const clamped = Math.min(QA_PAGE_CHARS_MAX, Math.max(QA_PAGE_CHARS_MIN, Math.floor(chars)));
        writePref(QA_PAGE_CHARS_KEY, String(clamped));
    }
}

// 单次最大输出 token（物理护栏）：设置后工坊每次请求带 max_tokens，超长输出被服务端
// 安全截断而不是把连接拖崩；引擎会把该预算写进系统提示，并在截断后自动续接。
// 默认 16000；存 "0" 表示用户显式选择不传该参数（兼容不支持 max_tokens 的模型/中转）。
// kv 键 ai_phone_qa_max_output_tokens 覆盖（调参/测试用）。
export const QA_DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const QA_MAX_OUTPUT_TOKENS_MIN = 256;
export const QA_MAX_OUTPUT_TOKENS_MAX = 1_000_000;

const QA_MAX_OUTPUT_TOKENS_KEY = "ai_phone_qa_max_output_tokens";
registerKvMigration(QA_MAX_OUTPUT_TOKENS_KEY);

export function getQaMaxOutputTokens(): number | null {
    const stored = readPref(QA_MAX_OUTPUT_TOKENS_KEY);
    if (stored === "0") return null; // 显式不传
    const raw = Number(stored);
    if (Number.isFinite(raw) && raw >= QA_MAX_OUTPUT_TOKENS_MIN && raw <= QA_MAX_OUTPUT_TOKENS_MAX) return Math.floor(raw);
    return QA_DEFAULT_MAX_OUTPUT_TOKENS;
}

/** 设置单次最大输出 token：null = 恢复默认；0 = 显式不传该参数 */
export function setQaMaxOutputTokens(tokens: number | null): void {
    if (tokens == null) writePref(QA_MAX_OUTPUT_TOKENS_KEY, null);
    else if (tokens === 0) writePref(QA_MAX_OUTPUT_TOKENS_KEY, "0");
    else {
        const clamped = Math.min(QA_MAX_OUTPUT_TOKENS_MAX, Math.max(QA_MAX_OUTPUT_TOKENS_MIN, Math.floor(tokens)));
        writePref(QA_MAX_OUTPUT_TOKENS_KEY, String(clamped));
    }
}

// 单轮工具调用上限：一次提问里 agent 最多连续执行多少轮工具，用完提示「回复继续」。
// kv 键 ai_phone_qa_max_rounds 覆盖（调参/测试用）。
export const QA_DEFAULT_MAX_ROUNDS = 20;
export const QA_MAX_ROUNDS_MIN = 1;
export const QA_MAX_ROUNDS_MAX = 50;

const QA_MAX_ROUNDS_KEY = "ai_phone_qa_max_rounds";
registerKvMigration(QA_MAX_ROUNDS_KEY);

export function getQaMaxRounds(): number {
    const raw = Number(readPref(QA_MAX_ROUNDS_KEY));
    if (Number.isFinite(raw) && raw >= QA_MAX_ROUNDS_MIN && raw <= QA_MAX_ROUNDS_MAX) return Math.floor(raw);
    return QA_DEFAULT_MAX_ROUNDS;
}

/** 设置单轮工具调用上限（null = 恢复默认） */
export function setQaMaxRounds(rounds: number | null): void {
    if (rounds == null) writePref(QA_MAX_ROUNDS_KEY, null);
    else {
        const clamped = Math.min(QA_MAX_ROUNDS_MAX, Math.max(QA_MAX_ROUNDS_MIN, Math.floor(rounds)));
        writePref(QA_MAX_ROUNDS_KEY, String(clamped));
    }
}
