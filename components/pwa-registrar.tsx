"use client";

import { useEffect } from "react";

export function PWARegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    let reloading = false;

    /**
     * 新版本 SW 接管后刷新一次页面。
     *
     * 刻意不在这里删 Cache Storage：新 SW 的 activate 阶段本来就已清掉旧版本缓存桶、
     * 并刚刚建好自己那份，此时再 caches.delete 会把新版刚写进去的 "/" 一起删掉，
     * 下次打开反而更慢。换壳的正确做法是让新 SW 自己在 install 阶段用
     * cache: "reload" 拉取最新 HTML（见 public/sw.js 的 PRECACHE_URLS）。
     *
     * 绝不触碰 IndexedDB / localStorage / sessionStorage——聊天记录、角色卡、
     * 世界书、API 配置、KV 数据全在其中。
     */
    const reloadForNewVersion = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        // 注册成功后主动拉一次 update：否则 iOS PWA 会长期沿用旧 SW 的缓存壳，
        // 改了代码在手机上看不到效果（配合 sw.js 里 CACHE_VERSION 升级一起生效）。
        .then((reg) => {
          void reg.update().catch(() => {});
          // 已有 SW 在跑（说明是升级而非首装）时，等到新版本进入 activated 就换壳刷新。
          const hadController = Boolean(navigator.serviceWorker.controller);
          if (!hadController) return;
          reg.addEventListener("updatefound", () => {
            const incoming = reg.installing;
            if (!incoming) return;
            incoming.addEventListener("statechange", () => {
              if (incoming.state !== "activated") return;
              if (cancelled) return;
              reloadForNewVersion();
            });
          });
        })
        .catch((error) => {
          console.warn("[PWA] Service worker registration failed:", error);
        });
    };

    if (document.readyState === "complete") {
      register();
      return () => {
        cancelled = true;
      };
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
