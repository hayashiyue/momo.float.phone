"use client";

import { useEffect } from "react";

export function PWARegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        // 注册成功后主动拉一次 update：否则 iOS PWA 会长期沿用旧 SW 的缓存壳，
        // 改了代码在手机上看不到效果（配合 sw.js 里 CACHE_VERSION 升级一起生效）。
        .then((reg) => { void reg.update().catch(() => {}); })
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
