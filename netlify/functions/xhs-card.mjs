/**
 * xhs-card.mjs —— 小红书笔记抓取与图片 Base64 转换服务（Netlify Function）
 * 版本：1.0.3
 * 作者：言嘉
 * 描述：针对海外 IP 与反爬混淆页面，放弃 JSON.parse，改用暴力正则直接硬抠标题、正文、作者与图片 CDN。
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
    const mobileUA =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

    // 1. 发起请求并跟随重定向，带全 Referer 伪装
    const pageRes = await fetch(targetUrl, {
      headers: {
        "User-Agent": mobileUA,
        "Referer": "https://www.xiaohongshu.com/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });

    const html = await pageRes.text();

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
              "User-Agent": mobileUA,
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
    return new Response(
      JSON.stringify({
        ok: false,
        error: err.message || "抓取失败",
      }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
