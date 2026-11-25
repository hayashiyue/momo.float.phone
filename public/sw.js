const CACHE_VERSION = "ai-phone-pwa-v33";
const NAVIGATE_FETCH_TIMEOUT_MS = 1800;
const ASSET_FETCH_TIMEOUT_MS = 8000;

function fetchWithSwTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// 注意：本项目实际使用的是 /manifest.webmanifest（见 app/layout.tsx），
// 此前写 /manifest.json 会 404 导致 cache.addAll 整批失败、"/" 根本没存进预缓存！
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // cache: "reload" 绕过浏览器 HTTP 磁盘缓存，确保预缓存的是本次部署的最新 HTML。
      // 否则新 SW 装好后缓存桶里仍是上一版页面壳，表现为「Vercel 已部署但界面还是旧的」。
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((url) =>
        cache.add(new Request(url, { cache: "reload" }))
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const oldKeys = keys.filter((key) => !key.startsWith(CACHE_VERSION));

    // ① 先把旧桶里现成的 "/" 快照抓出来做兜底种子。
    //    顺序至关重要：v29/v30 是「先把旧桶全删光、再去拉新的 "/" 且失败被 catch 吞掉」，
    //    一旦那一刻网络不通（弱网、切后台被冻结、平台刚好在发布），新桶没写进去、
    //    旧桶已经删干净，之后冷启动 networkFirst 既没有缓存也没有网络，
    //    根导航直接 throw —— 表现就是「重启手机后白屏」。
    let seed = null;
    for (const key of oldKeys) {
      try {
        const oldCache = await caches.open(key);
        const hit = await oldCache.match("/", { ignoreSearch: true });
        if (hit) { seed = hit; break; }
      } catch (error) { /* 单个旧桶读失败不影响其它桶 */ }
    }

    // ② 确保当前版本的静态桶里确实存有 "/"，拿不到就用旧桶的种子补位。
    const staticCache = await caches.open(STATIC_CACHE);
    const alreadyCached = await staticCache.match("/", { ignoreSearch: true });
    if (!alreadyCached) {
      let stored = false;
      try {
        await staticCache.add(new Request("/", { cache: "reload" }));
        stored = Boolean(await staticCache.match("/", { ignoreSearch: true }));
      } catch (error) { stored = false; }
      if (!stored && seed) {
        try {
          await staticCache.put("/", seed.clone());
          stored = Boolean(await staticCache.match("/", { ignoreSearch: true }));
        } catch (error) { stored = false; }
      }
      // 连种子都没有（首次安装且网络失败）：此时更不能删旧桶，留待下次激活重试。
      if (!stored && oldKeys.length > 0) {
        await self.clients.claim();
        return;
      }
    }

    // ③ 只有在当前版本的 "/" 确认可用之后，才清理旧版本缓存桶。
    await Promise.all(oldKeys.map((key) => caches.delete(key).catch(() => false)));

    // ④ 只做 claim，绝不在这里 client.navigate / reload。
    //    components/pwa-registrar.tsx 已在新 SW activated 时刷新一次页面，
    //    这里再 navigate 一遍等于同一毫秒级窗口内并发两条导航，
    //    iOS WebKit 上会互相打断，表现为「切回来一直重新加载」。
    await self.clients.claim();
  })());
});

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  return ["font", "image", "script", "style", "worker"].includes(request.destination);
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = (await cache.match(request, { ignoreSearch: true }))
    || (await caches.match("/", { ignoreSearch: true }));

  // 缓存优先：只要本地有旧壳就 0 毫秒直接返回，绝不等网络。
  // 原实现是「先等网络 1.8 秒再回退」，而 iOS WebKit 上 AbortController.abort()
  // 未必能中断已在进行的底层导航，.vercel.app 在国内握手黑洞时照样会等满
  // CFNetwork 的 60 秒，这才是「打开要一分多钟纯白屏」的真正来源。
  if (cached) {
    // 后台静默更新，不阻塞返回；失败也不影响本次打开。
    fetchWithSwTimeout(request, ASSET_FETCH_TIMEOUT_MS)
      .then((response) => { if (response.ok) cache.put(request, response.clone()); })
      .catch(() => {});
    return cached;
  }

  // 本地完全没缓存（首次安装）：只能等网络。
  try {
    const response = await fetchWithSwTimeout(request, NAVIGATE_FETCH_TIMEOUT_MS);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const fallback = await caches.match("/", { ignoreSearch: true });
    if (fallback) return fallback;
    throw error;
  }
}

// 静态资源（字体/图片/脚本/样式/模型）用 cache-first：命中缓存直接返回，
// 不再每次都在后台把整份文件重新拉一遍校验。字体动辄 7~24MB，旧的
// stale-while-revalidate 会持续重下，是带宽爆掉的主因之一。
// 需要更新缓存内容时，升 CACHE_VERSION 即可让旧缓存在 activate 时清空。
async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetchWithSwTimeout(request, ASSET_FETCH_TIMEOUT_MS);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// 离线推送：App 被杀后由系统唤起 SW 弹通知。payload 由服务端 JSON 编码。
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const declarative = data.web_push === 8030 && data.notification && typeof data.notification === "object"
    ? data.notification
    : null;
  const notificationData = declarative && declarative.data && typeof declarative.data === "object"
    ? declarative.data
    : data;
  const title = (declarative && declarative.title) || data.title || "小手机";
  event.waitUntil((async () => {
    if (notificationData.type === "chat_outbox") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    // 来电推送：页面可见时直接进页面振铃（来电横幅），不弹系统通知
    if (notificationData.type === "incoming_call") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length > 0) {
        visible.forEach((client) => client.postMessage({
          type: "incoming_call_push",
          sessionId: notificationData.sessionId || "",
          callTs: notificationData.callTs || 0,
        }));
        visible.forEach((client) => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    await self.registration.showNotification(title, {
      body: (declarative && declarative.body) || data.body || "",
      icon: (declarative && declarative.icon) || data.icon || "/icon-192.png",
      badge: (declarative && declarative.badge) || "/icon-192.png",
      tag: (declarative && declarative.tag) || data.tag || `push-${Date.now()}`,
      data: {
        url: (declarative && declarative.navigate) || notificationData.url || "/",
        type: notificationData.type || "",
        commandId: notificationData.commandId || "",
        sessionId: notificationData.sessionId || "",
        callTs: notificationData.callTs || 0,
      },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || "/";
  if (notificationData.type === "shortcut_command") {
    // iOS silently ignores custom URL schemes passed to clients.openWindow().
    event.waitUntil((async () => {
      const absoluteUrl = new URL(targetUrl, self.location.origin).href;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // 有活窗口：不导航（navigate 会杀掉 SPA，回来一片空白、进行中的生成全断）。
      // 交给页面自己 location 到 /shortcut-run——302 到 shortcuts:// 属于外部 App
      // 启动，WebKit 不会卸载当前页面，聊天界面与本地生成原地保留。
      for (const client of windows) {
        if ("focus" in client) {
          client.postMessage({ type: "run_shortcut", url: absoluteUrl });
          return client.focus();
        }
      }
      // App 已被杀：没有页面可保，开新窗口走 /shortcut-run 跳转
      return self.clients.openWindow(absoluteUrl);
    })());
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if (notificationData.type === "chat_outbox") {
            client.postMessage({ type: "push_outbox_ready" });
          }
          if (notificationData.type === "incoming_call") {
            // 有活窗口：不导航（会杀掉 SPA），交给页面弹来电横幅 + 合并 outbox
            client.postMessage({
              type: "incoming_call_push",
              sessionId: notificationData.sessionId || "",
              callTs: notificationData.callTs || 0,
            });
            client.postMessage({ type: "push_outbox_ready" });
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isCacheableRequest(request)) {
    event.respondWith(cacheFirst(request));
  }
});
