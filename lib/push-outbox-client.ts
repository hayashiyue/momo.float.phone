// 离线推送·回端合并：App 打开/回前台时拉取服务端生成的原始输出，
// 用客户端同一条解析管线（输出正则 → parseAndSaveResponse）落进聊天记录。

import { parseAndSaveResponse, scheduleFollowUp } from "./follow-up-service";
import { applyOutputRegex } from "./llm-prompt-assembler";
import type { RegexConfig } from "./settings-types";
import { stripHallucinatedTimestamps } from "./llm-provider-adapter";
import { MacroEngine } from "./macro-engine";
import { getActiveAppTags } from "./content-tag-utils";
import { loadChatMessages, loadChatSessions, reindexSessionMessageOrdersByTime } from "./chat-storage";
import { hasAccountPushSubscription } from "./push-client";
import { isPersonalPushCloudActive, loadPersonalPushCloudState, personalPushFetch } from "./personal-push-cloud";
import { removeTimedWakeSchedule } from "./timed-wake-storage";
import { appendBridgeFeed } from "./reality-bridge/storage";
import { loadScreenChatSettings, saveScreenChatAck } from "./reality-bridge/storage";

type OutboxEntry = {
    id: string;
    session_id: string | null;
    trigger_key: string | null;
    raw_text: string;
    meta: {
        sessionId?: string;
        followUpIndex?: number;
        prevCount?: number;
        regexes?: RegexConfig[];
        characterName?: string;
        userName?: string;
        appId?: string;
        appTags?: string[];
        followUpCount?: number;
        armAt?: string;
        /** 云端触发快捷动作失败的摘要；成功时不带这个字段 */
        shortcutDeliveryError?: string;
    } | null;
    created_at: string;
};

let consuming = false;
let lastConsumeAt = 0;
let consumerInstalled = false;
let consumeRequestTimer: number | null = null;

// 本地幂等记忆：记住最近已落库的 outbox 条目 id。
// 回执（ack）是网络请求，失败时条目会留在服务端，下一轮（5 分钟后）又被拉回来。
// 没有这层记忆时，同一条云端消息会被反复 parseAndSaveResponse 一遍遍插进聊天记录，
// 表现为「零碎地、多次地凭空多出几条」。id 只增不减，1% 命中即可短路。
const CONSUMED_OUTBOX_IDS_MAX = 200;
const CONSUMED_OUTBOX_IDS_STORAGE_KEY = "ai_phone_consumed_outbox_ids_v1";
const consumedOutboxIds: string[] = [];
const consumedOutboxIdSet = new Set<string>();

// 从 localStorage 恢复：ack 失败后若用户刷新/重开 App，内存集合会清空，
// 那条没销账的云端消息又会被拉回来重复插入。持久化后跨会话也拦得住。
(function restoreConsumedOutboxIds() {
    try {
        const raw = localStorage.getItem(CONSUMED_OUTBOX_IDS_STORAGE_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        for (const item of parsed) {
            if (typeof item !== "string" || !item || consumedOutboxIdSet.has(item)) continue;
            consumedOutboxIdSet.add(item);
            consumedOutboxIds.push(item);
        }
    } catch { /* 读失败就当空集合 */ }
})();

function flushConsumedOutboxIds(): void {
    try {
        localStorage.setItem(CONSUMED_OUTBOX_IDS_STORAGE_KEY, JSON.stringify(consumedOutboxIds));
    } catch { /* 写失败不影响本次运行 */ }
}

// 本轮合并开始前，各会话的本地基准。过期判定必须用这份「冻结」的快照比对：
// 若实时读，离线期间云端连发第 1 条落库后，第 2、3 条就会把刚插入的消息当成
// 「用户已经往前走了」的证据，全部误判为过期。
type SessionBaseline = { lastUserMsgId: string; lastUserMsgAtMs: number; lastMsgAtMs: number };
const preMergeSessionBaseline = new Map<string, SessionBaseline>();

function snapshotSessionBaseline(sessionId: string): SessionBaseline {
    const cached = preMergeSessionBaseline.get(sessionId);
    if (cached) return cached;
    const messages = loadChatMessages(sessionId);
    let lastUserMsgId = "";
    let lastUserMsgAtMs = 0;
    let lastMsgAtMs = 0;
    for (const message of messages) {
        const at = Date.parse(message.createdAt);
        if (Number.isFinite(at) && at > lastMsgAtMs) lastMsgAtMs = at;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === "user") {
            lastUserMsgId = messages[i].id;
            const at = Date.parse(messages[i].createdAt);
            lastUserMsgAtMs = Number.isFinite(at) ? at : 0;
            break;
        }
    }
    const baseline: SessionBaseline = { lastUserMsgId, lastUserMsgAtMs, lastMsgAtMs };
    preMergeSessionBaseline.set(sessionId, baseline);
    return baseline;
}

function rememberConsumedOutboxId(id: string): void {
    if (!id || consumedOutboxIdSet.has(id)) return;
    consumedOutboxIdSet.add(id);
    consumedOutboxIds.push(id);
    while (consumedOutboxIds.length > CONSUMED_OUTBOX_IDS_MAX) {
        const dropped = consumedOutboxIds.shift();
        if (dropped) consumedOutboxIdSet.delete(dropped);
    }
    flushConsumedOutboxIds();
}
const OUTBOX_BATCH_SIZE = 20;
const MAX_OUTBOX_BATCHES_PER_PASS = 10;
const OUTBOX_FOREGROUND_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function getTimedWakeIdFromTriggerKey(triggerKey: string | null): string | null {
    if (!triggerKey?.startsWith("timedwake:")) return null;
    const id = triggerKey.slice("timedwake:".length);
    return id.trim() || null;
}

function clearTimedWakeIfHandled(triggerKey: string | null): void {
    const timedWakeId = getTimedWakeIdFromTriggerKey(triggerKey);
    if (timedWakeId) removeTimedWakeSchedule(timedWakeId);
}

export async function consumeServerOutbox(options?: { silent?: boolean; force?: boolean }): Promise<void> {
    if (typeof window === "undefined") return;
    // 共享回传箱已紧急停用：没有个人 Supabase 时直接结束，不请求 status/outbox。
    if (!isPersonalPushCloudActive()) return;
    if (consuming) return;
    if (options?.force !== true && Date.now() - lastConsumeAt < OUTBOX_FOREGROUND_CHECK_INTERVAL_MS) return;
    // 没有任何设备订阅推送时，服务端不可能产生普通离线回传；避免所有在线用户空轮询。
    if (!loadScreenChatSettings().enabled && !(await hasAccountPushSubscription())) return;
    consuming = true;
    lastConsumeAt = Date.now();
    const passStartMs = Date.now();
    // 每轮消费重置会话基准：本轮期间合并进来的云端消息不能污染过期判定
    preMergeSessionBaseline.clear();
    try {
        // 共享回传箱已停用，只读取用户自己的 Supabase。
        const sources: Array<"personal" | "shared"> = ["personal"];
        const handledTriggerKeys = new Set<string>();
        for (const source of sources) {
          for (let batch = 0; batch < MAX_OUTBOX_BATCHES_PER_PASS; batch += 1) {
            const response = await (source === "personal"
                ? personalPushFetch("outbox")
                : fetch("/api/push/outbox", { credentials: "include" }))
                .catch(() => null);
            if (!response || !response.ok) break;
            const data = await response.json().catch(() => ({})) as { ok?: boolean; entries?: OutboxEntry[] };
            const entries = data.ok && Array.isArray(data.entries) ? data.entries : [];
            if (entries.length === 0) break;

            const consumedIds: string[] = [];
            for (const entry of entries) {
                try {
                    // 本地幂等：这条已经落过库了（上一轮 ack 失败导致服务端还留着），
                    // 只补一次 ack，绝不再 parseAndSaveResponse 插一遍。
                    if (consumedOutboxIdSet.has(entry.id)) {
                        consumedIds.push(entry.id);
                        continue;
                    }
                    if (entry.trigger_key && handledTriggerKeys.has(entry.trigger_key)) {
                        consumedIds.push(entry.id);
                        continue;
                    }
                    const meta = entry.meta || {};

                    if ((meta as { kind?: string }).kind === "bridge") {
                        const bridgeMeta = meta as Record<string, unknown> & {
                            reply?: { sessionId?: string; regexes?: RegexConfig[]; characterName?: string; userName?: string; appId?: string; appTags?: string[] } | null;
                            screenChat?: boolean;
                            screenChatCharacterId?: string;
                            screenChatSequence?: number;
                            screenChatResponseBatchId?: string;
                            screenChatAssistantAt?: string;
                        };
                        const engine = await import("./reality-bridge/engine");
                        const applied = await engine.applyServerBridgeEntry(bridgeMeta as Parameters<typeof engine.applyServerBridgeEntry>[0]);
                        const replyMeta = bridgeMeta.reply || null;
                        const replySessionId = applied.sessionId || replyMeta?.sessionId || "";
                        if (entry.raw_text.trim() && replySessionId) {
                            const responseBatchId = typeof bridgeMeta.screenChatResponseBatchId === "string"
                                ? bridgeMeta.screenChatResponseBatchId
                                : undefined;
                            const existing = loadChatMessages(replySessionId);
                            const alreadyImported = Boolean(
                                responseBatchId && existing.some(message => message.responseBatchId === responseBatchId),
                            );
                            if (!alreadyImported) {
                                let text = stripHallucinatedTimestamps(entry.raw_text.trim());
                                const regexes = Array.isArray(replyMeta?.regexes) ? replyMeta.regexes : [];
                                if (regexes.length > 0) {
                                    const macroEngine = new MacroEngine(replyMeta?.characterName ?? "", replyMeta?.userName ?? "用户");
                                    const activeTags = getActiveAppTags(replyMeta?.appId ?? "chat", { appTags: replyMeta?.appTags });
                                    text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
                                }
                                const { hasVisible, newCount, stateValues } = await parseAndSaveResponse(
                                    text,
                                    replySessionId,
                                    0,
                                    undefined,
                                    existing,
                                    {
                                        silent: options?.silent !== false,
                                        responseBatchId,
                                        createdAt: bridgeMeta.screenChatAssistantAt,
                                    },
                                );
                                if (hasVisible && newCount < 10) scheduleFollowUp(replySessionId, newCount, stateValues);
                            }
                            if (bridgeMeta.screenChat === true) reindexSessionMessageOrdersByTime(replySessionId);
                        }
                        if (
                            bridgeMeta.screenChat === true
                            && typeof bridgeMeta.screenChatCharacterId === "string"
                            && Number.isSafeInteger(bridgeMeta.screenChatSequence)
                        ) {
                            saveScreenChatAck(bridgeMeta.screenChatCharacterId, Number(bridgeMeta.screenChatSequence));
                        }
                        rememberConsumedOutboxId(entry.id);
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }
                    // 云端触发快捷动作失败的诊断行：角色已经说了"我去看一眼"却什么
                    // 都没发生，写进现实桥动态让用户查得到原因。这是一条独立的
                    // outbox 行（云端在投递之后才写），不是角色消息——消费掉即可，
                    // 绝不能走下面的建消息流程，否则聊天里会凭空多出一条。
                    if ((meta as { kind?: string }).kind === "shortcut_delivery_error") {
                        const detail = typeof meta.shortcutDeliveryError === "string"
                            ? meta.shortcutDeliveryError
                            : entry.raw_text;
                        try {
                            appendBridgeFeed({
                                id: `shortcut_fail_${entry.id}`,
                                type: "快捷动作",
                                payload: detail,
                                rules: [],
                                actions: [],
                                error: detail,
                                receivedAt: new Date().toISOString(),
                            });
                        } catch { /* 动态写失败不影响其余条目消费 */ }
                        consumedIds.push(entry.id);
                        continue;
                    }
                    const sessionId = meta.sessionId || entry.session_id || "";
                    const session = sessionId ? loadChatSessions().find(s => s.id === sessionId) : undefined;
                    if (!session) {
                        console.warn("[PushOutbox] session not found, keep entry pending:", entry.id, sessionId);
                        continue;
                    }

                    // 注意：periodCare / idleReconnect 的本地状态更新（标记本周期已触发、
                    // 冷场重连连发计数 +1）必须放在下面的过期判定之后。它们是副作用，
                    // 若在被判为过期废单的条目上也执行，会白白消耗一次连发额度、
                    // 或把本周期关怀永久标记为已触发。
                    const periodCare = (meta as { periodCare?: { characterId?: string; cycleKey?: string } }).periodCare;
                    const idleMeta = (meta as { idleReconnect?: { ruleId?: string; firedAt?: number } }).idleReconnect;

                    const followUpIndex = typeof meta.followUpIndex === "number" ? meta.followUpIndex : undefined;
                    const existingMessages = loadChatMessages(sessionId);
                    if (followUpIndex && existingMessages.some(m => m.role === "assistant" && m.followUpIndex === followUpIndex)) {
                        clearTimedWakeIfHandled(entry.trigger_key);
                        rememberConsumedOutboxId(entry.id);
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }

                    // 过期判定：建单快照基准。
                    //
                    // 云端用的请求体是「挂单那一刻」冻结的上下文。只要用户在挂单
                    // 之后又发过消息，本地就已经往前走了，而这份快照仍停在建单那
                    // 一刻。此时若放行，AI 会把几小时前的旧话题当成刚发生的事重说
                    // 一遍，还带着触发时刻的时间戳插进聊天记录。
                    //
                    // 关键：比对的是「本轮 consumeServerOutbox 开始前」的会话基准，
                    // 不是实时读到的最后一条。否则离线期间云端连发的第 2、3 条会
                    // 因为第 1 条刚刚落库而全部被判为过期——那样连发消息就全废了。
                    // 基准用「最后一条 user 消息」：只有用户自己说话才代表本地往前走。
                    const baseline = snapshotSessionBaseline(sessionId);
                    const snapshotLastUserMsgId = typeof (meta as { snapshotLastUserMsgId?: unknown }).snapshotLastUserMsgId === "string"
                        ? (meta as { snapshotLastUserMsgId: string }).snapshotLastUserMsgId
                        : "";
                    const armedAtMs = typeof (meta as { armedAt?: unknown }).armedAt === "string"
                        ? Date.parse((meta as { armedAt: string }).armedAt)
                        : NaN;

                    // 三条并列判定，任一命中即视为过期废单。
                    // 全部基于 baseline（本轮消费开始前的冻结快照），所以离线期间
                    // 云端连发的第 2、3 条不会把第 1 条刚落库的消息当成「本地已推进」
                    // 的证据——那时 baseline 早已定格，不会增长。
                    const armAtMs = typeof meta.armAt === "string" ? Date.parse(meta.armAt) : NaN;
                    // 三条并列判定，任一命中即视为过期废单。
                    //
                    // 关键区分：比对建单时刻(armedAt) 要看「用户消息」，比对预定触发
                    // 时刻(armAt) 才看「任意消息」。
                    // 因为角色自己的主动消息是 assistant 消息，会推高 lastMsgAtMs。
                    // 若拿 armedAt 去比 lastMsgAtMs，那么「9:00 云端发了第 1 条，
                    // 9:10 用户打开手机落库，10:00 云端发第 2 条」这个再正常不过的
                    // 场景里，第 2 条会因为 lastMsgAtMs(9:00) > armedAt(8:00) 被误杀。
                    // 而用户在 8:05 回过话，只有 lastUserMsgAtMs 才会推进——用它对
                    // armedAt 比对，既拦得住「用户已经聊过」，又不会误伤主动连发。
                    const isStale = Boolean(baseline) && (
                        // 一：挂单后用户又发过消息（最后一条 user 消息变了）
                        (Boolean(snapshotLastUserMsgId) && Boolean(baseline.lastUserMsgId)
                            && baseline.lastUserMsgId !== snapshotLastUserMsgId)
                        // 二：挂单之后用户发过消息（用 user 消息时间，留 2 秒宽限）
                        || (Number.isFinite(armedAtMs) && baseline.lastUserMsgAtMs > armedAtMs + 2000)
                        // 三：预定触发时刻之后本地已经聊过（这里用任意消息时间才对）
                        || (Number.isFinite(armAtMs) && baseline.lastMsgAtMs > armAtMs)
                    );
                    if (isStale) {
                        clearTimedWakeIfHandled(entry.trigger_key);
                        rememberConsumedOutboxId(entry.id);
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }

                    // 确认这条会真正落库之后，才更新本地状态副作用
                    if (periodCare?.characterId && periodCare.cycleKey) {
                        const { saveMenstrualPeriodCareTrigger } = await import("./menstrual-storage");
                        saveMenstrualPeriodCareTrigger({ characterId: periodCare.characterId, sessionId, cycleKey: periodCare.cycleKey });
                    }
                    if (idleMeta?.ruleId) {
                        const { markIdleReconnectFired } = await import("./idle-reconnect-storage");
                        markIdleReconnectFired(idleMeta.ruleId, typeof idleMeta.firedAt === "number" ? idleMeta.firedAt : Date.now());
                    }

                    let text = stripHallucinatedTimestamps(entry.raw_text.trim());
                    const regexes = Array.isArray(meta.regexes) ? meta.regexes : [];
                    if (regexes.length > 0) {
                        const macroEngine = new MacroEngine(meta.characterName ?? "", meta.userName ?? "用户");
                        const activeTags = getActiveAppTags(meta.appId ?? "chat", { appTags: meta.appTags, followUpCount: meta.followUpCount });
                        text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
                    }

                    // 云端执行过的快捷动作标记：在原始位置落一对 tool_call/tool_notice——
                    // 上下文里保留标记原文，UI 显示与小手机内直接调用一致
                    const rawMarker = (meta as { shortcutMarker?: { text?: unknown; insertAt?: unknown; name?: unknown } }).shortcutMarker;
                    const shortcutMarker = rawMarker
                        && typeof rawMarker.text === "string" && rawMarker.text
                        && typeof rawMarker.name === "string" && rawMarker.name
                        ? {
                            text: rawMarker.text,
                            insertAt: typeof rawMarker.insertAt === "number" && Number.isFinite(rawMarker.insertAt)
                                ? rawMarker.insertAt
                                : Number.MAX_SAFE_INTEGER,
                            name: rawMarker.name,
                        }
                        : undefined;
                    const effectiveCreatedAt = (typeof meta.armAt === "string" && meta.armAt) ? meta.armAt : entry.created_at;
                    const { hasVisible, newCount, stateValues } = await parseAndSaveResponse(
                        text,
                        sessionId,
                        meta.prevCount ?? 0,
                        followUpIndex,
                        existingMessages,
                        {
                            silent: options?.silent !== false,
                            createdAt: effectiveCreatedAt,
                            ...(shortcutMarker ? { shortcutMarker } : {}),
                        },
                    );
                    if (hasVisible && newCount < 10) scheduleFollowUp(sessionId, newCount, stateValues);
                    clearTimedWakeIfHandled(entry.trigger_key);
                    rememberConsumedOutboxId(entry.id);
                    consumedIds.push(entry.id);
                    if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                } catch (err) {
                    console.warn("[PushOutbox] merge failed for entry:", entry.id, err);
                    // 屏幕速聊各轮有严格因果顺序；前一轮未合并时不能越过它消费后一轮。
                    if ((entry.meta as { screenChat?: boolean } | null)?.screenChat === true) break;
                }
            }

            if (consumedIds.length === 0) break;
            const ackInit: RequestInit = {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: consumedIds }),
            };
            const ackResponse = await (source === "personal"
                ? personalPushFetch("outbox", ackInit)
                : fetch("/api/push/outbox", { ...ackInit, credentials: "include" }))
                .catch(() => null);
            if (!ackResponse || !ackResponse.ok) break;
            if (entries.length < OUTBOX_BATCH_SIZE) break;
          }
        }
    } finally {
        consuming = false;
    }
}

/** 安装自动消费钩子：启动后拉一次，之后每次回前台再拉。 */
export function installServerOutboxConsumer(): void {
    if (typeof window === "undefined" || consumerInstalled) return;
    consumerInstalled = true;

    // 启动时保留 5 分钟节流；回前台和 SW 明确告知新消息时强制补拉。
    // iOS 会在后台冻结页面，如果回前台仍被节流，屏幕速聊消息只能等到下次重启才会合并。
    const requestConsume = (force = false) => {
        if (consumeRequestTimer !== null) window.clearTimeout(consumeRequestTimer);
        consumeRequestTimer = window.setTimeout(() => {
            consumeRequestTimer = null;
            void consumeServerOutbox({ force });
        }, 150);
    };

    requestConsume(false);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) requestConsume(true);
    });
    window.addEventListener("pageshow", () => {
        if (typeof document === "undefined" || !document.hidden) requestConsume(true);
    });
    window.addEventListener("focus", () => {
        if (typeof document === "undefined" || !document.hidden) requestConsume(true);
    });
    navigator.serviceWorker?.addEventListener("message", (event) => {
        if (event.data?.type === "push_outbox_ready") {
            requestConsume(true);
            return;
        }
        if (event.data?.type === "run_shortcut" && typeof event.data.url === "string") {
            const url: string = event.data.url;
            // 站点线的 /shortcut-run 票据地址、个人线的同源转发路由，
            // 或个人云网关自己的 run 入口
            const personal = loadPersonalPushCloudState();
            const allowed = url.startsWith(`${window.location.origin}/shortcut-run`)
                || url.startsWith(`${window.location.origin}/personal-shortcut-run?`)
                || (personal !== null && url.startsWith(`${personal.url}/functions/v1/ai-phone-push?action=run&`));
            if (allowed) window.location.href = url;
        }
    });
}
