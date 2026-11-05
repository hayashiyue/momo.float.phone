"use client";

import { useState, useRef, useCallback, useEffect, type PointerEvent as ReactPointerEvent } from "react";

export type ApiDragState = {
    configId: string;
    configName: string;
    clientX: number;
    clientY: number;
    overGroupId: string | null; // null = 未悬停任何目标；"__ungrouped__" = 未分组区域；其他 = 文件夹 id
};

const LONG_PRESS_MS = 260;
const MOVE_CANCEL_PX = 10;

export function useApiDrag(onDropToGroup: (configId: string, targetGroupId: string | undefined) => void) {
    const [dragState, setDragState] = useState<ApiDragState | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPosRef = useRef<{ x: number; y: number; pointerId: number; configId: string; configName: string } | null>(null);
    const activeDragRef = useRef<ApiDragState | null>(null);
    const suppressClickRef = useRef(false);

    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const resolveDropTarget = (clientX: number, clientY: number): string | null => {
        if (typeof document === "undefined") return null;
        const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        if (!el) return null;
        const dropZone = el.closest<HTMLElement>("[data-api-drop-group]");
        if (!dropZone) return null;
        return dropZone.getAttribute("data-api-drop-group");
    };

    useEffect(() => {
        if (!dragState) return;

        const handleWindowPointerMove = (e: PointerEvent) => {
            if (!activeDragRef.current) return;
            e.preventDefault();
            const overGroupId = resolveDropTarget(e.clientX, e.clientY);
            const next: ApiDragState = {
                ...activeDragRef.current,
                clientX: e.clientX,
                clientY: e.clientY,
                overGroupId,
            };
            activeDragRef.current = next;
            setDragState(next);
        };

        const finishDrag = (commit: boolean) => {
            const current = activeDragRef.current;
            activeDragRef.current = null;
            setDragState(null);
            startPosRef.current = null;
            if (commit && current && current.overGroupId !== null) {
                const target = current.overGroupId === "__ungrouped__" ? undefined : current.overGroupId;
                onDropToGroup(current.configId, target);
            }
        };

        const handleWindowPointerUp = () => finishDrag(true);
        const handleWindowPointerCancel = () => finishDrag(false);

        window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
        window.addEventListener("pointerup", handleWindowPointerUp);
        window.addEventListener("pointercancel", handleWindowPointerCancel);
        return () => {
            window.removeEventListener("pointermove", handleWindowPointerMove);
            window.removeEventListener("pointerup", handleWindowPointerUp);
            window.removeEventListener("pointercancel", handleWindowPointerCancel);
        };
    }, [dragState !== null, onDropToGroup]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleCardPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>, configId: string, configName: string) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        // 忽略卡片内部按钮点击
        if ((e.target as HTMLElement).closest("button, input, select, a")) return;
        clearTimer();
        const clientX = e.clientX;
        const clientY = e.clientY;
        startPosRef.current = { x: clientX, y: clientY, pointerId: e.pointerId, configId, configName };
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (!startPosRef.current) return;
            suppressClickRef.current = true;
            const overGroupId = resolveDropTarget(startPosRef.current.x, startPosRef.current.y);
            const initial: ApiDragState = {
                configId: startPosRef.current.configId,
                configName: startPosRef.current.configName,
                clientX: startPosRef.current.x,
                clientY: startPosRef.current.y,
                overGroupId,
            };
            activeDragRef.current = initial;
            setDragState(initial);
        }, LONG_PRESS_MS);
    }, [clearTimer]);

    const handleCardPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
        if (activeDragRef.current) return;
        if (!startPosRef.current) return;
        const dx = e.clientX - startPosRef.current.x;
        const dy = e.clientY - startPosRef.current.y;
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
            clearTimer();
            startPosRef.current = null;
        }
    }, [clearTimer]);

    const handleCardPointerEnd = useCallback(() => {
        clearTimer();
        if (!activeDragRef.current) {
            startPosRef.current = null;
        }
    }, [clearTimer]);

    const consumeClickSuppression = useCallback((): boolean => {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return true;
        }
        return false;
    }, []);

    return {
        dragState,
        handleCardPointerDown,
        handleCardPointerMove,
        handleCardPointerEnd,
        consumeClickSuppression,
    };
}
