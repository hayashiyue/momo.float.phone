import { saveChatImageToIndexedDB } from "./chat-asset-storage";
import { syncChatGeneratedImagePromptText, updateChatMessage, type ChatMessage } from "./chat-storage";
import { generatedImageFilename, generateImageFromConfiguredApi } from "./image-generation-service";
import { updateMomentPost } from "./moments-storage";
import type { MomentPost } from "./moments-types";

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function dispatchChatMessagesUpdated(sessionId: string, message: ChatMessage): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("chat-messages-updated", {
        detail: { sessionId, message },
    }));
}

function dispatchMomentsUpdated(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("moments-updated"));
}

export function createPendingChatGeneratedImageData(
    mediaData: ChatMessage["mediaData"] | undefined,
    description?: string,
): ChatMessage["mediaData"] {
    const label = (description || mediaData?.label || "").trim();
    return {
        ...mediaData,
        label,
        imageGenerationStatus: "pending",
        imageGenerationError: undefined,
    };
}

export function isPendingChatGeneratedImageMessage(message: Pick<ChatMessage, "mediaType" | "mediaData">): boolean {
    return message.mediaType === "image" && message.mediaData?.imageGenerationStatus === "pending";
}

/**
 * 正在生成中的图片任务：messageId → 控制器。
 *
 * 聊天室不再 await 生图（否则图片没画完输入框就被锁住），
 * 「停止」按钮已不是生图的唯一出口。用户要单独叫停某张图时，
 * 由图片气泡右上角的小叉号调用 cancelChatGeneratedImage 中断。
 */
const activeImageGenerations = new Map<string, AbortController>();

export function cancelChatGeneratedImage(messageId: string): boolean {
    const controller = activeImageGenerations.get(messageId);
    if (!controller) return false;
    controller.abort();
    activeImageGenerations.delete(messageId);
    return true;
}

export async function generateAndApplyChatGeneratedImage(
    message: ChatMessage,
    characterId?: string,
    options?: { signal?: AbortSignal; description?: string; useReferenceImage?: boolean; useUserReferenceImage?: boolean },
): Promise<ChatMessage> {
    const previousDescription = message.mediaData?.label?.trim() || "";
    const description = (options?.description ?? previousDescription).trim();
    if (!description) throw new Error("缺少图片描述，无法重新生成");

    const effectiveUseReference = options?.useReferenceImage !== undefined
        ? options.useReferenceImage
        : (message.mediaData?.useReferenceImage === true);
    const effectiveUseUserReference = options?.useUserReferenceImage !== undefined
        ? options.useUserReferenceImage
        : (message.mediaData?.useUserReferenceImage === true);

    if (
        (previousDescription && previousDescription !== description) ||
        (options?.useReferenceImage !== undefined && options.useReferenceImage !== (message.mediaData?.useReferenceImage === true))
    ) {
        syncChatGeneratedImagePromptText(message.id, previousDescription, description, options?.useReferenceImage);
    }

    // 重试路径：先落库为 pending 并广播，气泡立刻切到"生成中"态（首次生图本来就是 pending，无需重写）。
    // 之后无论成功/失败都会再写一次状态，不会卡在 pending。
    if (message.mediaData?.imageGenerationStatus !== "pending") {
        const marked = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                useReferenceImage: effectiveUseReference,
                useUserReferenceImage: effectiveUseUserReference,
                imageGenerationStatus: "pending",
                imageGenerationError: undefined,
            },
        });
        if (marked) dispatchChatMessagesUpdated(marked.sessionId, marked);
    }

    // 合并「本轮生成的 signal」与「这张图自己的控制器」：
    // 点聊天室停止按钮会中断本轮全部生图，点图片上的叉号只中断这一张。
    const localController = new AbortController();
    const externalSignal = options?.signal;
    const onExternalAbort = () => localController.abort();
    if (externalSignal) {
        if (externalSignal.aborted) localController.abort();
        else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    activeImageGenerations.set(message.id, localController);

    try {
        const generated = await generateImageFromConfiguredApi({
            description,
            characterId,
            appId: "chat",
            useReferenceImage: effectiveUseReference,
            includeUserReferenceImage: effectiveUseUserReference ? undefined : false,
            signal: localController.signal,
        });
        if (!generated) throw new Error("生图配置未启用或不完整");

        const fileName = generatedImageFilename(description, generated.mimeType);
        const previousData = message.mediaData ?? {};
        const nextData: ChatMessage["mediaData"] = {
            ...previousData,
            label: description,
            fileType: "image",
            fileName,
            useReferenceImage: effectiveUseReference,
            useUserReferenceImage: effectiveUseUserReference,
            imageGenerationMediaRef: generated.mediaRef,
            imageGenerationPrompt: generated.prompt,
            imageGenerationUsedReference: generated.usedReferenceImage,
            imageGenerationStatus: "generated",
            imageGenerationError: undefined,
        };
        const updated = updateChatMessage(message.id, {
            content: fileName,
            mediaType: "media_file",
            // 优先落轻量引用：完整 base64 会随 ChatMessage 一起被 chat-db 启动时
            // 全量 toArray 常驻 JS 堆，一张几 MB，几张就是几十上百 MB 的死亡线。
            // media-store:// 引用由 ImageBubble / MediaFileBubble 的
            // isMediaStoreRef + loadMediaObjectUrl 解析并在卸载时 revokeObjectURL。
            mediaUrl: generated.mediaRef || generated.dataUrl,
            mediaData: nextData,
        });
        if (!updated) throw new Error("原消息不存在，无法替换图片");
        dispatchChatMessagesUpdated(updated.sessionId, updated);
        return updated;
    } catch (error) {
        // 用户主动取消：不写成 failed（否则气泡弹红字），静默结束。
        const aborted = localController.signal.aborted;
        const failed = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                useReferenceImage: effectiveUseReference,
                useUserReferenceImage: effectiveUseUserReference,
                imageGenerationStatus: aborted ? undefined : "failed",
                imageGenerationError: aborted ? undefined : errorToMessage(error),
            },
        });
        if (failed) dispatchChatMessagesUpdated(failed.sessionId, failed);
        // 返回已写库的新对象：旧 message 还带 pending，onUpdate 会把「生成中」覆盖回界面。
        if (aborted) return failed ?? message;
        throw error;
    } finally {
        if (activeImageGenerations.get(message.id) === localController) {
            activeImageGenerations.delete(message.id);
        }
        externalSignal?.removeEventListener("abort", onExternalAbort);
    }
}

export async function retryChatGeneratedImage(
    message: ChatMessage,
    characterId?: string,
    nextDescription?: string,
    useReferenceImage?: boolean,
    useUserReferenceImage?: boolean,
): Promise<ChatMessage> {
    return generateAndApplyChatGeneratedImage(message, characterId, {
        description: nextDescription,
        useReferenceImage,
        useUserReferenceImage,
    });
}

export async function retryMomentGeneratedPhoto(
    post: MomentPost,
    nextDescription?: string,
    useReferenceImage?: boolean,
    useUserReferenceImage?: boolean,
): Promise<MomentPost> {
    const description = (nextDescription ?? post.photoDescription)?.trim();
    if (!description) throw new Error("缺少图片描述，无法重新生成");

    const effectiveUseReference = useReferenceImage !== undefined
        ? useReferenceImage
        : (post.photoUseReferenceImage === true);
    const effectiveUseUserReference = useUserReferenceImage !== undefined
        ? useUserReferenceImage
        : (post.photoUseUserReferenceImage === true);

    // 同聊天：重试先置 pending 并广播，卡片立刻显示"图片生成中…"；成功/失败都会再写状态。
    updateMomentPost(post.id, {
        photoDescription: description,
        photoUseReferenceImage: effectiveUseReference,
        photoUseUserReferenceImage: effectiveUseUserReference,
        photoGenerationStatus: "pending",
        photoGenerationError: undefined,
    });
    dispatchMomentsUpdated();

    try {
        const generated = await generateImageFromConfiguredApi({
            description,
            characterId: post.authorType === "character" ? post.authorId : undefined,
            appId: "moments",
            useReferenceImage: effectiveUseReference,
            includeUserReferenceImage: effectiveUseUserReference ? undefined : false,
        });
        if (!generated) throw new Error("生图配置未启用或不完整");

        const assetId = await saveChatImageToIndexedDB(generated.blob);
        const updated = updateMomentPost(post.id, {
            photoUrl: `asset://${assetId}`,
            photoDescription: description,
            photoUseReferenceImage: effectiveUseReference,
            photoUseUserReferenceImage: effectiveUseUserReference,
            photoGenerationStatus: "generated",
            photoGenerationPrompt: generated.prompt,
            photoGenerationError: undefined,
        });
        if (!updated) throw new Error("原朋友圈不存在，无法替换图片");
        dispatchMomentsUpdated();
        return updated;
    } catch (error) {
        updateMomentPost(post.id, {
            photoDescription: description,
            photoUseReferenceImage: effectiveUseReference,
            photoUseUserReferenceImage: effectiveUseUserReference,
            photoGenerationStatus: "failed",
            photoGenerationError: errorToMessage(error),
        });
        dispatchMomentsUpdated();
        throw error;
    }
}
