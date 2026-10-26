/**
 * xhs-card.mjs —— 小红书笔记抓取与图片 Base64 转换服务（Netlify Function）
 * 版本：1.0.4
 * 作者：言嘉
 * 描述：针对海外 IP 与短链协议问题，改用 PC UA 并手动拦截 302 重定向，防 xhsdiscover 协议导致 fetch 崩溃。
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

/**
 * 解码 unicode 转义字符（例如 \u4f60\u597d -> 你好）
 */
function decodeUnicode(str) {
  if (!str) return "";
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

export default async function handler(request, context) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const urlObj = new URL(request.url);
  const targetUrl = urlObj.searchParams.get("url");

  if (!targetUrl) {
    return new Response(
      JSON.stringify({ ok: false, error: "缺少 url 参数" }),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  try {
    const PC_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    // 1. 手动追踪重定向，避免遇到 xhsdiscover:// 导致 node fetch 崩溃
    let currentUrl = targetUrl;
    let finalHtml = "";
    let redirects = 0;

    while (redirects < 5) {
      redirects++;
      const res = await fetch(currentUrl, {
        headers: {
          "User-Agent": PC_UA,
          "Referer": "https://www.xiaohongshu.com/",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
        redirect: "manual",
      });

      if ([301, 302, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) break;
        if (loc.startsWith("xhsdiscover://")) {
          const m = loc.match(/item\/([a-zA-Z0-9]+)/);
          if (m && m[1]) {
            currentUrl = `https://www.xiaohongshu.com/explore/${m[1]}`;
            continue;
          }
        }
        currentUrl = new URL(loc, currentUrl).href;
        continue;
      }

      finalHtml = await res.text();
      break;
    }

    if (!finalHtml) {
      throw new Error(`未能获取到网页内容（最终尝试地址：${currentUrl}）`);
    }

    const html = finalHtml;

    // 2. 暴力正则提取：标题
    let title = "";
    const titleMatch = html.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (titleMatch && titleMatch[1]) {
      title = decodeUnicode(titleMatch[1]);
    }
    if (!title) {
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                      html.match(/<title>([^<]+)<\/title>/i);
      if (ogTitle && ogTitle[1]) {
        title = ogTitle[1].replace(/ - 小红书.*$/, "").trim();
      }
    }

    // 3. 暴力正则提取：正文
    let desc = "";
    const descMatch = html.match(/"desc"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (descMatch && descMatch[1]) {
      desc = decodeUnicode(descMatch[1]);
    }
    if (!desc) {
      const ogDesc = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i);
      if (ogDesc && ogDesc[1]) {
        desc = ogDesc[1].trim();
      }
    }

    // 4. 暴力正则提取：作者昵称
    let author = "";
    const nicknameMatch = html.match(/"nickname"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (nicknameMatch && nicknameMatch[1]) {
      author = decodeUnicode(nicknameMatch[1]);
    }
    if (!author) {
      const authorMeta = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i);
      if (authorMeta && authorMeta[1]) {
        author = authorMeta[1].trim();
      }
    }

    // 5. 暴力正则提取：图片 CDN 链接（硬抠 ci.xiaohongshu.com 与 xhscdn.com）
    const imageCandidates = [];
    const imageRegex = /https?:\/\/(?:ci\.xiaohongshu\.com|sns-webpic-qc\.xhscdn\.com|sns-img-[a-z0-9\-]+\.xhscdn\.com)\/[a-zA-Z0-9_\-\/]+/gi;
    const allMatches = html.match(imageRegex) || [];

    for (let rawUrl of allMatches) {
      // 过滤头像与图标，去除转义反斜杠
      const cleanUrl = rawUrl.replace(/\\/g, "");
      if (
        !cleanUrl.includes("avatar") &&
        !cleanUrl.includes("icon") &&
        !cleanUrl.includes("default") &&
        !imageCandidates.includes(cleanUrl)
      ) {
        imageCandidates.push(cleanUrl);
      }
    }

    // 去重后取前 3 张下载转 Base64
    const imagesToFetch = imageCandidates.slice(0, 3);
    const images = [];

    await Promise.all(
      imagesToFetch.map(async (imgUrl) => {
        try {
          // 加缩略图参数，减小传输体积，防止超时
          let fetchUrl = imgUrl;
          if (!fetchUrl.includes("?")) {
            fetchUrl += "?imageView2/2/w/800/format/jpg";
          }

          const imgRes = await fetch(fetchUrl, {
            headers: {
              "User-Agent": PC_UA,
              "Referer": "https://www.xiaohongshu.com/",
            },
          });

          if (imgRes.ok) {
            const buffer = await imgRes.arrayBuffer();
            const base64 = Buffer.from(buffer).toString("base64");
            images.push({
              dataUrl: `data:image/jpeg;base64,${base64}`,
              url: imgUrl,
            });
          }
        } catch (err) {
          // 单张拉取失败跳过
        }
      })
    );

    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          title: title.trim() || "小红书笔记",
          desc: desc.trim(),
          author: author.trim() || "小红书用户",
          images,
          comments: [],
        },
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err) {
    const causeMsg = err.cause ? (err.cause.message || err.cause.code || String(err.cause)) : "";
    return new Response(
      JSON.stringify({
        ok: false,
        error: err.message || "抓取失败",
        cause: causeMsg,
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
