"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadStickerPacksForCharacters, type StickerPack } from "@/lib/custom-sticker-storage";
import { getThemeAssetMap } from "@/lib/theme-storage";
import { BUILTIN_SCREEN_EFFECTS, loadBuiltinScreenEffectSettings } from "@/lib/chat-screen-effects";

// ── Emoji categories ─────────────────────────────

const EMOJI_CATEGORIES: { name: string; emojis: string[] }[] = [
    {
        name: "常用",
        emojis: [
            "😀", "😂", "🤣", "😊", "😍", "🥰", "😘", "😜", "🤔", "😏",
            "😅", "😭", "😤", "🥺", "😳", "🤗", "😴", "🤮", "👍", "👎",
            "👏", "🙏", "💪", "❤️", "💔", "🔥", "✨", "🎉", "😎", "🤡",
        ],
    },
    {
        name: "表情",
        emojis: [
            "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😉",
            "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😋", "😛",
            "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨",
            "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥", "😌", "😔",
            "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🥵", "🥶",
            "🥴", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "😟", "😕",
        ],
    },
    {
        name: "手势",
        emojis: [
            "👋", "🤚", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🫰",
            "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎",
            "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏",
            "💪", "🫶", "🫂", "💅", "🖐️", "🫴", "🫳",
        ],
    },
    {
        name: "爱心",
        emojis: [
            "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💕",
            "💞", "💓", "💗", "💖", "💘", "💝", "💔", "❤️‍🔥", "💋", "🫀",
        ],
    },
    {
        name: "动物",
        emojis: [
            "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
            "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🦄", "🐝",
            "🦋", "🐌", "🐛", "🐞", "🐙", "🐠", "🐬", "🐳", "🦈", "🐊",
        ],
    },
    {
        name: "食物",
        emojis: [
            "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍑",
            "🍒", "🥝", "🍅", "🥑", "🍕", "🍔", "🍟", "🌭", "🍿", "🧁",
            "🍩", "🍪", "🎂", "🍰", "🍫", "🍬", "☕", "🍵", "🧋", "🍺",
        ],
    },
];

// ── Props ─────────────────────────────

interface EmojiPanelProps {
    onSelect: (emoji: string) => void;
    /** 点击「特效」栏的特效表情：以该文本为消息内容直接发送并播放全屏特效 */
    onEffectSend?: (text: string) => void;
}

export function EmojiPanel({ onSelect, onEffectSend }: EmojiPanelProps) {
    const [emojiCategory, setEmojiCategory] = useState(0);
    // 特效栏只显示启用中的内置特效；面板挂载时读取一次即可
    const [enabledEffects] = useState(() => {
        if (!onEffectSend) return [];
        const settings = loadBuiltinScreenEffectSettings();
        return BUILTIN_SCREEN_EFFECTS.filter(effect => settings[effect.type].enabled);
    });
    const effectCategoryIndex = EMOJI_CATEGORIES.length;
    const showEffectTab = enabledEffects.length > 0;

    return (
        <div className="h-[220px] flex flex-col">
            <div className="flex gap-0.5 px-2 py-1 overflow-x-auto shrink-0 hide-scrollbar">
                {showEffectTab && (
                    <button
                        onClick={() => setEmojiCategory(effectCategoryIndex)}
                        className="emoji-category-pill"
                        {...(emojiCategory === effectCategoryIndex ? { "data-active": "" } : {})}
                    >特效</button>
                )}
                {EMOJI_CATEGORIES.map((cat, i) => (
                    <button
                        key={i}
                        onClick={() => setEmojiCategory(i)}
                        className="emoji-category-pill"
                        {...(emojiCategory === i ? { "data-active": "" } : {})}
                    >{cat.name}</button>
                ))}
            </div>
            {emojiCategory === effectCategoryIndex && showEffectTab ? (
                <div className="flex-1 overflow-auto px-2 py-1 grid grid-cols-4 gap-1.5 content-start hide-scrollbar">
                    {enabledEffects.map(effect => (
                        <button
                            key={effect.type}
                            onClick={() => onEffectSend?.(effect.icon)}
                            className="emoji-effect-tile"
                            title={effect.name}
                        >
                            <span className="emoji-effect-tile-icon">{effect.icon}</span>
                            <span className="emoji-effect-tile-name">{effect.name}</span>
                        </button>
                    ))}
                </div>
            ) : (
                <div className="flex-1 overflow-auto px-2 py-1 grid grid-cols-8 gap-0.5 content-start hide-scrollbar">
                    {EMOJI_CATEGORIES[emojiCategory].emojis.map((emoji, i) => (
                        <button
                            key={i}
                            onClick={() => onSelect(emoji)}
                            className="border-none bg-transparent ts-18 cursor-pointer p-0.5 rounded-lg flex items-center justify-center aspect-square"
                        >{emoji}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Sticker Panel ─────────────────────────────

interface StickerPanelProps {
    onSend: (name: string, stickerUrl?: string) => void;
    characterId?: string;
    characterIds?: string[];
}

const STICKER_PAGE_BATCH = 35;

export function StickerPanel({ onSend, characterId, characterIds }: StickerPanelProps) {
    const [stickerPacks, setStickerPacks] = useState<StickerPack[]>([]);
    const [activePackId, setActivePackId] = useState<string | null>(null);
    const [packUrlMap, setPackUrlMap] = useState<Record<string, string>>({});
    const [visibleLimit, setVisibleLimit] = useState(STICKER_PAGE_BATCH);

    useEffect(() => {
        const ids = characterIds && characterIds.length > 0 ? characterIds : characterId ? [characterId] : [];
        if (ids.length === 0) {
            setStickerPacks([]);
            setActivePackId(null);
            setPackUrlMap({});
            return;
        }
        const packs = loadStickerPacksForCharacters(ids).filter(pack => pack.stickers.length > 0);
        setStickerPacks(packs);
        setActivePackId(prev => (prev && packs.some(pack => pack.id === prev) ? prev : packs[0]?.id ?? null));
    }, [characterId, characterIds]);

    const activePack = stickerPacks.find(pack => pack.id === activePackId) ?? stickerPacks[0] ?? null;

    useEffect(() => {
        setVisibleLimit(STICKER_PAGE_BATCH);
    }, [activePack?.id]);

    useEffect(() => {
        if (!activePack) return;
        let cancelled = false;
        const visibleStickers = activePack.stickers.slice(0, visibleLimit);
        const immediate: Record<string, string> = {};
        const pendingAssetIds: string[] = [];
        for (const s of visibleStickers) {
            // 用贴纸 id 而非 name 作 key：包内同名/空名表情会让 URL 互相覆盖，
            // 而渲染侧 React key 用的也是 id，两边必须一致。
            const key = `${activePack.id}:${s.id}`;
            if (packUrlMap[key]) continue;
            if (s.externalUrl) {
                immediate[key] = s.externalUrl;
            } else if (s.assetId) {
                pendingAssetIds.push(s.assetId);
            }
        }
        if (Object.keys(immediate).length > 0) {
            setPackUrlMap(prev => ({ ...prev, ...immediate }));
        }
        if (pendingAssetIds.length > 0) {
            getThemeAssetMap(pendingAssetIds).then(assetMap => {
                if (cancelled) return;
                const resolved: Record<string, string> = {};
                for (const s of visibleStickers) {
                    if (s.assetId && assetMap[s.assetId]) {
                        resolved[`${activePack.id}:${s.id}`] = assetMap[s.assetId];
                    }
                }
                if (Object.keys(resolved).length > 0) {
                    setPackUrlMap(prev => ({ ...prev, ...resolved }));
                }
            }).catch(() => {});
        }
        return () => { cancelled = true; };
    }, [activePack, visibleLimit]); // eslint-disable-line react-hooks/exhaustive-deps

    // 滚动到距底 160px 内自动追加一批，不再需要手动点「加载更多」
    const gridRef = useRef<HTMLDivElement | null>(null);
    const loadMoreIfNeeded = useCallback(() => {
        const el = gridRef.current;
        if (!el || !activePack) return;
        if (visibleLimit >= activePack.stickers.length) return;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
            setVisibleLimit(v => Math.min(activePack.stickers.length, v + STICKER_PAGE_BATCH));
        }
    }, [activePack, visibleLimit]);

    // 首屏没填满（大屏/桌面端滑不动）时自动继续追加，否则永远停在第一批
    useEffect(() => {
        const el = gridRef.current;
        if (!el || !activePack) return;
        if (visibleLimit >= activePack.stickers.length) return;
        if (el.scrollHeight <= el.clientHeight + 40) {
            setVisibleLimit(v => Math.min(activePack.stickers.length, v + STICKER_PAGE_BATCH));
        }
    }, [activePack, visibleLimit]);

    return (
        <div className="h-[220px] flex flex-col">
            {stickerPacks.length > 0 && (
                <div className="flex gap-0.5 px-2 py-1 overflow-x-auto shrink-0 hide-scrollbar">
                    {stickerPacks.map(pack => (
                        <button
                            key={pack.id}
                            onClick={() => setActivePackId(pack.id)}
                            className="emoji-category-pill"
                            {...(activePack?.id === pack.id ? { "data-active": "" } : {})}
                        >
                            {pack.name}
                        </button>
                    ))}
                </div>
            )}
            <div ref={gridRef} onScroll={loadMoreIfNeeded} className="flex-1 overflow-auto p-2 grid grid-cols-5 gap-1 content-start hide-scrollbar">
                {!activePack && (
                    <div className="col-span-5 flex items-center justify-center text-[var(--c-text-muted)] ts-12 py-8">
                        暂无表情包，请在角色设置里上传或绑定。
                    </div>
                )}
                {activePack?.stickers.slice(0, visibleLimit).map(sticker => {
                    const url = packUrlMap[`${activePack.id}:${sticker.id}`];
                    return (
                        <button
                            key={`${activePack.id}:${sticker.id}`}
                            onClick={() => onSend(sticker.name, url)}
                            title={sticker.name}
                            className="border-none bg-transparent cursor-pointer p-1 rounded-lg flex flex-col items-center justify-start gap-0.5 min-h-[62px] min-w-0 overflow-hidden"
                        >
                            <div className="w-9 h-9 flex items-center justify-center shrink-0">
                                {url ? (
                                    <img src={url} alt={sticker.name} decoding="async" className="w-9 h-9 object-contain" />
                                ) : (
                                    <span className="ts-9 text-[var(--c-text)] max-w-full truncate">{sticker.name}</span>
                                )}
                            </div>
                            <span className="ts-9 leading-tight text-[var(--c-text)] opacity-75 w-full text-center truncate">
                                {sticker.name}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
