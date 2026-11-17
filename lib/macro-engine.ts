// lib/macro-engine.ts
// Macro expansion engine.
// Uses regex-based iterative innermost-first expansion.

import { buildCharacterTimeContext, getSystemTimeZone } from "./character-time";

const TRIM_SENTINEL = "\x00TRIM\x00";

// ── 纯静态宏展开缓存 ──────────────────────────────────────────
// 判定「整段文本只含 {{char}} / {{user}} / {{trim}}」后，展开结果只与角色名、用户名有关。
// 缓存键带上 charName 与 userName，换角色卡自然失效；用 Map 有界防止无限增长。
const STATIC_MACRO_CACHE_LIMIT = 800;
const _staticMacroExpandCache = new Map<string, string>();
// 出现任何一个非静态宏（动态值、变量读写、随机数、未识别占位符等）就放弃缓存。
// 注意：必须与实际 resolve 支持的静态宏集合保持一致，宁可少缓存也不能缓存错。
// 必须与 resolve() 的实际分支严格逐字符一致：那边用的是 body === "char" /
// "user" / "trim"，既不 trim 也不忽略大小写。这里放宽只会把 resolve 不认识的
// {{CHAR}} / {{ char }} 误判为静态（它们会被原样返回，结果虽仍不变，
// 但白名单与实际行为不一致会让后续维护者误以为支持这些写法）。
const STATIC_MACRO_ALLOWED_RE = /^\{\{(?:char|user|trim|\/\/[^{}]*)\}\}$/;

function isPurelyStaticMacroText(text: string): boolean {
    // 关键防线：只要存在嵌套花括号（如 {{getvar::{{char}}}}）就直接放弃缓存。
    // 原因：下面的 tokenRe 用了 [^{}]*?，只能匹配到**最内层**的 {{char}}，
    // 外层的 {{getvar::...}} 因中间夹着花括号而完全漏检 —— 若不先拦截，
    // 这类「外层是动态宏、内层是静态宏」的结构会被误判为纯静态，
    // 从而把随轮次变化的变量值永久缓存住。
    if (/\{\{[^{}]*\{\{/.test(text)) return false;
    // 局部正则：带 g 标志的 RegExp 会携带 lastIndex 状态，
    // 模块级共享会在重入（同一 tick 内嵌套调用）时互相污染。
    const tokenRe = /\{\{([^{}]*?)\}\}/g;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = tokenRe.exec(text)) !== null) {
        found = true;
        if (!STATIC_MACRO_ALLOWED_RE.test(match[0])) return false;
    }
    // 上一行已经保证 text 含 "{{"，若一个 token 都没匹配到（例如孤立的花括号），
    // 说明结构异常，同样不缓存。
    return found;
}



export class MacroEngine {
    localVars: Map<string, string> = new Map();
    globalVars: Map<string, string> = new Map();
    charName: string;
    userName: string;
    lastUserMessage: string = "";
    lastCharMessage: string = "";
    lastMessage: string = "";
    currentInput: string = "";
    // Character card fields
    description: string = "";
    personality: string = "";
    persona: string = "";
    group: string = "";
    // App-specific fields
    stateStr: string = "";
    followUpCount: number = 0;
    followUpDelay: number = 0;
    timedWakeElapsedMinutes: string = "";
    timedWakeIntent: string = "";
    periodCareContext: string = "";
    timeContext: string = "";
    systemTimeZone: string = "";
    characterTime: string = "";
    characterTimeZone: string = "";
    characterWeekday: string = "";
    customStickerNames: string = "";
    customStickerExample: string = "";
    musicLocal: string = "";
    musicCloud: string = "";
    musicOnlineHint: string = "";
    currentSchedule: string = "";
    vnScenes: string = "";
    vnSprites: string = "";
    vnBeats: string = "";
    vnCurrentBeat: string = "";
    affinity: string = "";
    // Tool definitions
    tools: string = "";
    cocreateWriteActions: string = "";
    cocreateReadActions: string = "";
    groupTools: string = "";
    groupRoster: string = "";
    customAppRichMediaDirectives: string = "";
    chatBilingualInstruction: string = "";
    statusRegionSection: string = "";
    statusRegionExampleLine: string = "";
    statusRegionComposition: string = "";
    statusRegionFullExample: string = "";
    offlineBilingualInstruction: string = "";
    offlineSummaryTag: string = "summary";
    checkPhoneBilingualInstruction: string = "";
    xiaohongshuBilingualInstruction: string = "";
    phoneAppId: string = "";
    phoneAppLabel: string = "";
    phoneSnapshotSummary: string = "";
    phoneLastRefreshAt: string = "";
    // Dwelling fields
    dwellingRoom: string = "";
    dwellingFurniture: string = "";
    dwellingItem: string = "";
    dwellingItemPreview: string = "";
    bookTitle: string = "";
    chapterTitle: string = "";
    chapterContent: string = "";
    annotationHistory: string = "";
    noteWallContext: string = "";
    diaryEntryContext: string = "";
    xiaohongshuFeedContext: string = "";
    xiaohongshuUserPostContext: string = "";
    xiaohongshuCommentContext: string = "";
    xiaohongshuMentionContext: string = "";
    interviewTheme: string = "";
    interviewHostName: string = "";
    interviewGuests: string = "";
    interviewGuestCount: string = "";
    interviewCurrentGuest: string = "";
    interviewOtherGuests: string = "";
    interviewQuestion: string = "";
    interviewTranscript: string = "";
    interviewPhase: string = "";
    interviewRound: string = "";
    interviewUserAnswer: string = "";
    interviewCharacterAnswerHistory: string = "";
    cocreateProjectContext: string = "";
    cocreateCurrentMode: string = "";
    cocreateCurrentChapter: string = "";
    cocreateChapterIndex: string = "";
    cocreateArchivedChapterContext: string = "";
    cocreateWriterNotebook: string = "";

    constructor(charName: string, userName: string) {
        this.charName = charName;
        this.userName = userName;
    }

    /** Main entry: iteratively expand all macros (innermost first). */
    expand(text: string): string {
        // 绝大多数世界书正文、预设条目与聊天消息里根本没有宏。对它们跑一遍
        // /\{\{([^{}]*?)\}\}/gs 全文扫描纯属白烧主线程（每轮生成要过几百个 block）。
        // includes("{{") 是引擎内建的子串查找，比正则快一到两个数量级，且语义完全等价：
        // 不含 "{{" 的字符串不可能被该正则匹配到任何内容。
        if (!text || !text.includes("{{")) return text;
        // 纯静态宏缓存：只含 {{char}} / {{user}}（以及 {{trim}} 哨兵）的条目，
        // 其展开结果只取决于 charName 与 userName。世界书里 95% 的含宏条目属于这一类，
        // 只要角色名/用户名不变，展开结果恒等 —— 命中即可跳过全部正则迭代。
        // 含任何动态宏（{{time}} / {{state}} / {{getvar}} / {{random}} …）的文本一律不缓存。
        // 名字本身若含 "{{"，替换进去会引入新的宏，后续轮次可能解析出动态值
        // （例如角色名被写成 "{{random::A::B}}"），此时结果不再恒定，不能缓存。
        if (!this.charName.includes("{{") && !this.userName.includes("{{")
            && isPurelyStaticMacroText(text)) {
            const cacheKey = `${this.charName}\u0000${this.userName}\u0000${text}`;
            const cached = _staticMacroExpandCache.get(cacheKey);
            if (cached !== undefined) return cached;
            const expanded = this.expandUncached(text);
            if (_staticMacroExpandCache.size >= STATIC_MACRO_CACHE_LIMIT) {
                const oldest = _staticMacroExpandCache.keys().next().value;
                if (oldest !== undefined) _staticMacroExpandCache.delete(oldest);
            }
            _staticMacroExpandCache.set(cacheKey, expanded);
            return expanded;
        }
        return this.expandUncached(text);
    }

    private expandUncached(text: string): string {
        const MAX_ITERATIONS = 50;
        let result = text;
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            // 每轮替换后可能已无宏：提前退出，省掉一次确认性的全文正则。
            if (!result.includes("{{")) break;
            const pass = this.expandInnermostTracked(result);
            // 一轮里没有任何宏被真正替换 → 剩下的都是无法解析的宏，
            // 再跑 N 轮结果也不会变。直接结束，省掉 MAX_ITERATIONS-1 轮
            // 全文正则 + 全文比对（世界书正文动辄数万字，这是主要浪费之一）。
            if (!pass.changed) break;
            result = pass.text;
            // 这里刻意不再额外判断「是否嵌套」：
            // 真正的二层嵌套（如 {{getvar::{{char}}}}）在第 1 轮内层展开后，
            // 外层会合拢成一层 {{getvar::名字}}，此时 result 仍含 "{{"，
            // 下一轮循环开头的 includes("{{") 检查会自然放行并继续展开；
            // 而替换结果里不含 "{{" 时，下一轮开头即 break。
            // 多说一句：曾经尝试在这里用「替换后是否仍有两层花括号」来提前退出，
            // 但嵌套结构恰恰是在内层替换后才降到一层，那样判断会把它误杀。
        }
        return result;
    }

    /** Single pass: find and replace all innermost {{...}} (no nested braces inside). */
    private expandInnermost(text: string): string {
        return this.expandInnermostTracked(text).text;
    }

    /**
     * 与 expandInnermost 相同，但额外报告本轮是否真的替换掉了至少一个宏。
     * 没有任何替换时，剩下的都是无法解析的宏，再迭代也不会变。
     */
    private expandInnermostTracked(text: string): { text: string; changed: boolean } {
        let changed = false;
        const next = text.replace(/\{\{([^{}]*?)\}\}/gs, (match: string, body: string) => {
            const resolved = this.resolve(body);
            if (resolved !== match) changed = true;
            return resolved;
        });
        return { text: next, changed };
    }

    /** Resolve a single macro body (content between {{ and }}). */
    private resolve(body: string): string {
        // Comment: {{//...}}
        if (body.startsWith("//")) {
            return "";
        }

        // trim
        if (body === "trim") {
            return TRIM_SENTINEL;
        }

        // char / user
        if (body === "char") return this.charName;
        if (body === "user") return this.userName;

        // lastUserMessage / lastCharMessage / lastMessage
        if (body === "lastUserMessage") return this.lastUserMessage;
        if (body === "lastCharMessage") return this.lastCharMessage;
        if (body === "lastMessage") return this.lastMessage;

        // input
        if (body === "input") return this.currentInput;

        // Character card fields
        if (body === "description") return this.description;
        if (body === "personality") return this.personality;
        if (body === "persona") return this.persona;
        if (body === "group") return this.group;

        // App-specific fields
        if (body === "affinity") return this.affinity;
        if (body === "state") return this.stateStr;
        if (body === "count") return String(this.followUpCount);
        if (body === "delay") return String(this.followUpDelay);
        if (body === "timedWakeElapsedMinutes" || body === "timedWakeMinutes") return this.timedWakeElapsedMinutes || "0";
        if (body === "timedWakeIntent") return this.timedWakeIntent || "\x00TRIM\x00";
        if (body === "periodCareContext") return this.periodCareContext || "\x00TRIM\x00";
        if (body === "timeContext") return this.timeContext || buildCharacterTimeContext().timeContext;
        if (body === "systemTimeZone") return this.systemTimeZone || getSystemTimeZone();
        if (body === "characterTime") return this.characterTime || "\x00TRIM\x00";
        if (body === "characterTimeZone") return this.characterTimeZone || "\x00TRIM\x00";
        if (body === "characterWeekday") return this.characterWeekday || "\x00TRIM\x00";
        if (body === "customStickers") return this.customStickerNames || "\x00TRIM\x00";
        if (body === "stickerExample") return this.customStickerExample || "\x00TRIM\x00";
        if (body === "musicLocal") return this.musicLocal || "无";
        if (body === "musicCloud") return this.musicCloud || "无";
        if (body === "musicOnlineHint") return this.musicOnlineHint;
        if (body === "currentSchedule" || body === "当前日程") return this.currentSchedule || "无";
        if (body === "vnScenes") return this.vnScenes || "暂无";
        if (body === "vnSprites") return this.vnSprites || "暂无";
        if (body === "vnBeats") return this.vnBeats || "\x00TRIM\x00";
        if (body === "vnCurrentBeat") return this.vnCurrentBeat || "\x00TRIM\x00";

        // Tool definitions
        if (body === "tools") return this.tools || "\x00TRIM\x00";
        if (body === "cocreateWriteActions") return this.cocreateWriteActions || "\x00TRIM\x00";
        if (body === "cocreateReadActions") return this.cocreateReadActions || "\x00TRIM\x00";
        if (body === "groupTools") return this.groupTools || "\x00TRIM\x00";
        if (body === "groupRoster") return this.groupRoster || "\x00TRIM\x00";
        if (body === "customAppRichMediaDirectives" || body === "customAppChatCapabilities") return this.customAppRichMediaDirectives || "\x00TRIM\x00";
        if (body === "chatBilingualInstruction") return this.chatBilingualInstruction || "\x00TRIM\x00";
        // 状态区宏：空值直返空串而非 TRIM——TRIM 会吞掉相邻换行把上下行粘死，off 挡留空行更安全
        if (body === "statusRegionSection") return this.statusRegionSection;
        if (body === "statusRegionExampleLine") return this.statusRegionExampleLine;
        if (body === "statusRegionComposition") return this.statusRegionComposition;
        if (body === "statusRegionFullExample") return this.statusRegionFullExample;
        if (body === "offlineBilingualInstruction") return this.offlineBilingualInstruction || "\x00TRIM\x00";
        if (body === "offlineSummaryTag") return this.offlineSummaryTag || "summary";
        if (body === "checkPhoneBilingualInstruction") return this.checkPhoneBilingualInstruction || "\x00TRIM\x00";
        if (body === "xiaohongshuBilingualInstruction") return this.xiaohongshuBilingualInstruction || "\x00TRIM\x00";
        if (body === "phoneAppId") return this.phoneAppId || "\x00TRIM\x00";
        if (body === "phoneAppLabel") return this.phoneAppLabel || "\x00TRIM\x00";
        if (body === "phoneSnapshotSummary") return this.phoneSnapshotSummary || "\x00TRIM\x00";
        if (body === "phoneLastRefreshAt") return this.phoneLastRefreshAt || "\x00TRIM\x00";

        // Dwelling fields
        if (body === "dwellingRoom") return this.dwellingRoom || "\x00TRIM\x00";
        if (body === "dwellingFurniture") return this.dwellingFurniture || "\x00TRIM\x00";
        if (body === "dwellingItem") return this.dwellingItem || "\x00TRIM\x00";
        if (body === "dwellingItemPreview") return this.dwellingItemPreview || "\x00TRIM\x00";
        if (body === "bookTitle") return this.bookTitle || "\x00TRIM\x00";
        if (body === "chapterTitle") return this.chapterTitle || "\x00TRIM\x00";
        if (body === "chapterContent") return this.chapterContent || "\x00TRIM\x00";
        if (body === "annotationHistory") return this.annotationHistory || "\x00TRIM\x00";
        if (body === "noteWallContext") return this.noteWallContext || "暂无便签";
        if (body === "diaryEntryContext") return this.diaryEntryContext || "暂无日记";
        if (body === "xiaohongshuFeedContext") return this.xiaohongshuFeedContext || "暂无小红书笔记";
        if (body === "xiaohongshuUserPostContext") return this.xiaohongshuUserPostContext || "暂无用户小红书笔记";
        if (body === "xiaohongshuCommentContext") return this.xiaohongshuCommentContext || "暂无小红书评论上下文";
        if (body === "xiaohongshuMentionContext") return this.xiaohongshuMentionContext || "暂无小红书@上下文";
        if (body === "interviewTheme") return this.interviewTheme || "\x00TRIM\x00";
        if (body === "interviewHostName") return this.interviewHostName || "主持人";
        if (body === "interviewGuests") return this.interviewGuests || this.charName || "\x00TRIM\x00";
        if (body === "interviewGuestCount") return this.interviewGuestCount || "1";
        if (body === "interviewCurrentGuest") return this.interviewCurrentGuest || this.charName || "\x00TRIM\x00";
        if (body === "interviewOtherGuests") return this.interviewOtherGuests || "无";
        if (body === "interviewQuestion") return this.interviewQuestion || "\x00TRIM\x00";
        if (body === "interviewTranscript") return this.interviewTranscript || "（暂无采访实录）";
        if (body === "interviewPhase") return this.interviewPhase || "\x00TRIM\x00";
        if (body === "interviewRound") return this.interviewRound || "1";
        if (body === "interviewUserAnswer") return this.interviewUserAnswer || "\x00TRIM\x00";
        if (body === "interviewCharacterAnswerHistory") return this.interviewCharacterAnswerHistory || "（暂无）";
        if (body === "cocreateProjectContext") return this.cocreateProjectContext || "\x00TRIM\x00";
        if (body === "cocreateCurrentMode") return this.cocreateCurrentMode || "\x00TRIM\x00";
        if (body === "cocreateCurrentChapter") return this.cocreateCurrentChapter || "\x00TRIM\x00";
        if (body === "cocreateChapterIndex") return this.cocreateChapterIndex || "暂无章节目录。";
        if (body === "cocreateArchivedChapterContext") return this.cocreateArchivedChapterContext || "暂无已结束章节。";
        if (body === "cocreateWriterNotebook") return this.cocreateWriterNotebook || "暂无笔记。";

        // realCharacterList — 用户创建的其他角色名单（不含当前角色），供朋友圈等场景做"真实角色"判定
        if (body === "realCharacterList") {
            try {
                // 延迟 require，避免模块加载期的存储访问与潜在循环依赖
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { loadCharacters } = require("./character-storage") as typeof import("./character-storage");
                const names = loadCharacters()
                    .map(c => (c.name || "").trim())
                    .filter(n => n && n !== this.charName);
                return names.length ? names.join("、") : "（无）";
            } catch {
                return "（无）";
            }
        }

        // time — shortcut for current datetime like "2026年3月2日15:40"
        if (body === "time") {
            const now = new Date();
            return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        }

        if (body === "weekday") {
            const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
            return weekdays[new Date().getDay()];
        }

        // uuid
        if (body === "uuid") {
            if (typeof crypto !== "undefined" && crypto.randomUUID) {
                return crypto.randomUUID();
            }
            // Fallback
            return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
                const r = (Math.random() * 16) | 0;
                return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
            });
        }

        // setvar::name::value
        if (body.startsWith("setvar::")) {
            const parts = body.substring(8).split("::");
            if (parts.length >= 2) {
                const name = parts[0];
                const value = parts.slice(1).join("::");
                this.localVars.set(name, value);
            }
            return "";
        }

        // getvar::name
        if (body.startsWith("getvar::")) {
            const name = body.substring(8);
            return this.localVars.get(name) ?? "";
        }

        // setglobalvar::name::value
        if (body.startsWith("setglobalvar::")) {
            const parts = body.substring(14).split("::");
            if (parts.length >= 2) {
                const name = parts[0];
                const value = parts.slice(1).join("::");
                this.globalVars.set(name, value);
            }
            return "";
        }

        // getglobalvar::name
        if (body.startsWith("getglobalvar::")) {
            const name = body.substring(14);
            return this.globalVars.get(name) ?? "";
        }

        // random::a::b::c  (:: separated)
        if (body.startsWith("random::")) {
            const items = body.substring(8).split("::").filter(Boolean);
            if (items.length > 0) {
                return items[Math.floor(Math.random() * items.length)];
            }
            return "";
        }

        // random:a,b,c  (comma or newline separated, single colon)
        if (body.startsWith("random:") && !body.startsWith("random::")) {
            const rest = body.substring(7);
            // Split by comma or newline
            const items = rest.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
            if (items.length > 0) {
                return items[Math.floor(Math.random() * items.length)];
            }
            return "";
        }

        // timestamp:FORMAT
        if (body.startsWith("timestamp:")) {
            const format = body.substring(10).trim();
            return formatTimestamp(format);
        }
        if (body === "timestamp") {
            return new Date().toISOString();
        }

        // Unrecognized macro — leave as-is (return with braces so it doesn't loop)
        return `{{${body}}}`;
    }
}

/** Post-process: remove {{trim}} sentinels and surrounding newlines. */
export function postProcessTrim(text: string): string {
    // 不含 trim 哨兵的文本（绝大多数世界书/预设条目）直接返回，省掉一次全文正则。
    // 注意：原正则以 \n* 开头，无法走首字符快速跳转，对每条条目都是纯线性扫描。
    if (!text || !text.includes(TRIM_SENTINEL)) return text;
    // Remove trim sentinels along with any surrounding newlines
    return text.replace(/\n*\x00TRIM\x00\n*/g, "");
}

/** Simple timestamp formatter. Supports common tokens: YYYY, MM, DD, HH, mm, ss, etc. */
function formatTimestamp(format: string): string {
    const now = new Date();
    const pad = (n: number, len = 2) => String(n).padStart(len, "0");

    return format
        .replace(/YYYY/g, String(now.getFullYear()))
        .replace(/YY/g, String(now.getFullYear()).slice(-2))
        .replace(/MM/g, pad(now.getMonth() + 1))
        .replace(/DD/g, pad(now.getDate()))
        .replace(/HH/g, pad(now.getHours()))
        .replace(/hh/g, pad(now.getHours() % 12 || 12))
        .replace(/mm/g, pad(now.getMinutes()))
        .replace(/ss/g, pad(now.getSeconds()))
        .replace(/A/g, now.getHours() >= 12 ? "PM" : "AM")
        .replace(/a/g, now.getHours() >= 12 ? "pm" : "am");
}
