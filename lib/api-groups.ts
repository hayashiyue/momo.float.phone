/**
 * API 文件夹（ApiGroup）的装配/变更工具。
 * 
 * 设计约定：
 * - 文件夹本身只存 { id, name, collapsed }，不存 API 列表；归属关系写在 ApiConfig.groupId 上。
 * - 因此「删文件夹」绝不能删 API —— 释放到未分组（groupId 清空）后再删文件夹。
 * - 所有写库函数都返回新的列表，方便调用方直接 setState。
 */
import type { ApiConfig, ApiGroup } from "./settings-types";
import { loadApiConfigs, loadApiGroups, saveApiConfigs, saveApiGroups } from "./settings-storage";

export type GroupedApiSection = {
    group: ApiGroup;
    items: ApiConfig[];
};

export type GroupedApiView = {
    sections: GroupedApiSection[];
    ungrouped: ApiConfig[];
};

/**
 * API 列表/文件夹的展示排序模式：
 * - "name"：按名称自然排序（数字与英文在前，中文在后）
 * - "time"：保持存储顺序（即添加时的先后顺序）
 * 仅影响展示，saveApiConfigs / saveApiGroups 始终按原始数组顺序落库。
 */
export type ApiSortMode = "name" | "time";

const API_SORT_MODE_KEY = "ai_phone_api_sort_mode_v1";

let _sortModeCache: ApiSortMode | null = null;

export function loadApiSortMode(): ApiSortMode {
    if (_sortModeCache) return _sortModeCache;
    try {
        const raw = typeof window !== "undefined" ? localStorage.getItem(API_SORT_MODE_KEY) : null;
        _sortModeCache = raw === "time" ? "time" : "name";
    } catch {
        _sortModeCache = "name";
    }
    return _sortModeCache;
}

export function saveApiSortMode(mode: ApiSortMode): void {
    _sortModeCache = mode;
    try {
        if (typeof window !== "undefined") localStorage.setItem(API_SORT_MODE_KEY, mode);
    } catch {
        /* ignore quota / privacy mode */
    }
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("api-sort-mode-changed"));
    }
}

/** 取首字符码点：ASCII（数字/英文字母/半角符号）优先于非 ASCII（中文等）。 */
function isAsciiLead(text: string): boolean {
    if (!text) return true;
    return text.charCodeAt(0) <= 0x7f;
}

/**
 * 名称比较：数字与英文（ASCII 开头）整体排在中文（非 ASCII 开头）之前，
 * 各自组内用自然序（numeric: true 让 1 / 2 / 10 按数序而非字典序）。
 * 不用 "zh-CN" 做全局 locale，否则中文会被排到英文前面。
 */
export function compareLabelAsciiFirst(a: string, b: string): number {
    const left = (a || "").trim();
    const right = (b || "").trim();
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    const leftAscii = isAsciiLead(left);
    const rightAscii = isAsciiLead(right);
    if (leftAscii !== rightAscii) return leftAscii ? -1 : 1;
    return left.localeCompare(right, leftAscii ? undefined : "zh-CN", {
        numeric: true,
        sensitivity: "base",
    });
}

/**
 * 纯展示用的排序（不改存储顺序）。
 * 只在下拉选择器 / 列表渲染时调用；saveApiConfigs 仍按原始数组顺序落库，
 * 因此拖拽排序、configs[0] 默认取值、文件夹归属全都不受影响。
 */
export function sortApiConfigsByName(configs: ApiConfig[]): ApiConfig[] {
    if (loadApiSortMode() === "time") return [...configs];
    return [...configs].sort((a, b) =>
        compareLabelAsciiFirst(a.name || a.defaultModel || a.provider || "", b.name || b.defaultModel || b.provider || ""),
    );
}

/** 文件夹按名称排序（"time" 模式保持存储顺序）。 */
export function sortApiGroupsByName(groups: ApiGroup[]): ApiGroup[] {
    if (loadApiSortMode() === "time") return [...groups];
    return [...groups].sort((a, b) => compareLabelAsciiFirst(a.name || "", b.name || ""));
}

/**
 * 按文件夹顺序分组；groupId 指向不存在文件夹的条目自动归入 ungrouped（防御孤儿引用）。
 * 内部按 loadApiSortMode() 决定文件夹顺序与组内 API 顺序。
 */
export function buildGroupedApiView(configs: ApiConfig[], groups: ApiGroup[]): GroupedApiView {
    const sortMode = loadApiSortMode();
    const sortedGroups = sortApiGroupsByName(groups);
    const groupMap = new Map<string, ApiConfig[]>();
    for (const g of groups) {
        groupMap.set(g.id, []);
    }
    const ungrouped: ApiConfig[] = [];
    for (const cfg of configs) {
        if (cfg.groupId && groupMap.has(cfg.groupId)) {
            groupMap.get(cfg.groupId)!.push(cfg);
        } else {
            ungrouped.push(cfg);
        }
    }
    const sections: GroupedApiSection[] = sortedGroups.map(group => ({
        group,
        items: sortMode === "time" ? (groupMap.get(group.id) || []) : sortApiConfigsByName(groupMap.get(group.id) || []),
    }));
    return { sections, ungrouped: sortMode === "time" ? ungrouped : sortApiConfigsByName(ungrouped) };
}

export function createApiGroup(name: string, currentGroups?: ApiGroup[]): ApiGroup[] {
    const groups = currentGroups ?? loadApiGroups();
    const trimmed = name.trim() || "新建文件夹";
    const next: ApiGroup[] = [
        ...groups,
        {
            id: `api_group_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: trimmed,
            collapsed: false,
        },
    ];
    saveApiGroups(next);
    return next;
}

export function renameApiGroup(groupId: string, name: string, currentGroups?: ApiGroup[]): ApiGroup[] {
    const groups = currentGroups ?? loadApiGroups();
    const trimmed = name.trim();
    if (!trimmed) return groups;
    const next = groups.map(g => (g.id === groupId ? { ...g, name: trimmed } : g));
    saveApiGroups(next);
    return next;
}

export function toggleApiGroupCollapsed(groupId: string, currentGroups?: ApiGroup[]): ApiGroup[] {
    const groups = currentGroups ?? loadApiGroups();
    const next = groups.map(g => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g));
    saveApiGroups(next);
    return next;
}

/**
 * 删除文件夹：把该文件夹下的所有 API 释放回未分组（清除 groupId），然后移除文件夹。
 */
export function deleteApiGroupAndRelease(
    groupId: string,
    currentGroups?: ApiGroup[],
    currentConfigs?: ApiConfig[],
): { groups: ApiGroup[]; configs: ApiConfig[] } {
    const groups = (currentGroups ?? loadApiGroups()).filter(g => g.id !== groupId);
    const rawConfigs = currentConfigs ?? loadApiConfigs();
    let changed = false;
    const configs = rawConfigs.map(cfg => {
        if (cfg.groupId !== groupId) return cfg;
        changed = true;
        const next = { ...cfg };
        delete next.groupId;
        return next;
    });
    saveApiGroups(groups);
    if (changed) saveApiConfigs(configs);
    return { groups, configs };
}

/**
 * 将指定 API 移入目标文件夹（groupId 为 undefined/null/空串 时移回未分组）。
 */
export function moveApiConfigToGroup(
    configId: string,
    targetGroupId: string | undefined | null,
    currentConfigs?: ApiConfig[],
): ApiConfig[] {
    const rawConfigs = currentConfigs ?? loadApiConfigs();
    const normalizedTarget = targetGroupId ? targetGroupId : undefined;
    let changed = false;
    const configs = rawConfigs.map(cfg => {
        if (cfg.id !== configId) return cfg;
        if ((cfg.groupId || undefined) === normalizedTarget) return cfg;
        changed = true;
        const next = { ...cfg };
        if (normalizedTarget) {
            next.groupId = normalizedTarget;
        } else {
            delete next.groupId;
        }
        return next;
    });
    if (changed) saveApiConfigs(configs);
    return configs;
}
