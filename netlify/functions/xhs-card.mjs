/**
 * xhs-card.mjs —— 小红书笔记抓取与图片 Base64 转换服务（Netlify Function）
 * 版本：1.0.2
 * 作者：言嘉
 * 描述：支持 xhslink.com / xhslink.cn / xiaohongshu.com，
 *       放宽 __INITIAL_STATE__ 与 __INITIAL_SSR_STATE__ 匹配，支持深度 Meta 兜底与 debug 输出。
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

/**
 * 从文本起始的大括号处通过括号深度计数截取合法 JSON 字符串
 */
function extractBalancedJsonObject(str, startIndex) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  const len = str.length;

  for (let i = startIndex; i < len; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) {
          return str.slice(startIndex, i + 1);
        }
      }
    }
  }
  return null;
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
    // 模拟现代主流移动端 Safari UA
    const mobileUA =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

    // 1. 发起请求并跟随 302 重定向
    const pageRes = await fetch(targetUrl, {
      headers: {
        "User-Agent": mobileUA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      redirect: "follow",
    });

    const finalUrl = pageRes.url || targetUrl;
    const html = await pageRes.text();

    // 2. 多重正则匹配 window.__INITIAL_STATE__ 或 window.__INITIAL_SSR_STATE__
    let stateData = null;
    let stateMatchedKey = "";

    const statePatterns = [
      /window\.__INITIAL_STATE__\s*=\s*(\{)/,
      /window\.__INITIAL_SSR_STATE__\s*=\s*(\{)/,
      /__INITIAL_STATE__\s*=\s*(\{)/,
    ];

    for (const pattern of statePatterns) {
      const match = html.match(pattern);
      if (match && match.index !== undefined) {
        const braceIndex = match.index + match[0].length - 1;
        const jsonStr = extractBalancedJsonObject(html, braceIndex);
        if (jsonStr) {
          try {
            // 清理非法字面量
            const sanitized = jsonStr.replace(/:\s*undefined\b/g, ": null");
            stateData = JSON.parse(sanitized);
            stateMatchedKey = pattern.source;
            break;
          } catch (e) {
            // JSON 语法容错
          }
        }
      }
    }

    // 3. 多分支提取笔记核心对象
    let note = null;
    if (stateData) {
      if (stateData.note?.noteDetailMap) {
        const firstId = Object.keys(stateData.note.noteDetailMap)[0];
        note = stateData.note.noteDetailMap[firstId]?.note;
      } else if (stateData.noteData) {
        note = stateData.noteData;
      } else if (stateData.note?.currentNote) {
        note = stateData.note.currentNote;
      } else if (stateData.feed?.currentNote) {
        note = stateData.feed.currentNote;
      }
    }

    let title = note?.title || "";
    let desc = note?.desc || "";
    let author = note?.user?.nickname || "";
    let rawImageUrls = [];

    // 从 state 提取图片列表
    if (note?.imageList && Array.isArray(note.imageList)) {
      rawImageUrls = note.imageList
        .map((img) => img.urlDefault || img.url || (img.infoList && img.infoList[0]?.url))
        .filter(Boolean);
    }

    // 4. 深度 Meta 兜底（如果 state 没有完整拿到）
    if (!title) {
      const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       html.match(/<meta\s+name=["']og:title["']\s+content=["']([^"']+)["']/i);
      const docTitle = html.match(/<title>([^<]+)<\/title>/i);
      if (ogTitle && ogTitle[1]) {
        title = ogTitle[1].replace(/ - 小红书.*$/, "").trim();
      } else if (docTitle && docTitle[1]) {
        title = docTitle[1].replace(/ - 小红书.*$/, "").trim();
      }
    }

    if (!desc) {
      const ogDesc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
                      html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
      if (ogDesc && ogDesc[1]) {
        desc = ogDesc[1].trim();
      }
    }

    if (!author) {
      const authorMatch = html.match(/<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i);
      if (authorMatch && authorMatch[1]) author = authorMatch[1].trim();
    }

    // 图片 Meta / 标签全面兜底
    if (rawImageUrls.length === 0) {
      // 匹配所有 og:image
      const ogImageMatches = html.matchAll(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/gi);
      for (const m of ogImageMatches) {
        if (m[1]) rawImageUrls.push(m[1]);
      }

      // 匹配 twitter:image
      if (rawImageUrls.length === 0) {
        const twitterImg = html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
        if (twitterImg && twitterImg[1]) rawImageUrls.push(twitterImg[1]);
      }

      // 正则扫描 HTML 内所有小红书 CDN 图片链接 (sns-webpic / ci.xiaohongshu / sns-img)
      if (rawImageUrls.length === 0) {
        const cdnMatches = html.matchAll(/https?:\/\/[a-zA-Z0-9.\-_]*xhscdn\.com\/[a-zA-Z0-9_\-\/]+/gi);
        for (const m of cdnMatches) {
          const u = m[0];
          // 排除头像和图标类
          if (!u.includes("avatar") && !u.includes("icon") && !rawImageUrls.includes(u)) {
            rawImageUrls.push(u);
          }
        }
      }
    }

    // 提取热评
    let comments = [];
    if (stateData?.comment?.comments && Array.isArray(stateData.comment.comments)) {
      comments = stateData.comment.comments.slice(0, 5).map((c) => ({
        user: c.user?.nickname || "网友",
        content: c.content || "",
        likeCount: c.likeCount || 0,
      }));
    }

    // 5. 将抓取到的图片下载并转为 Base64（最多 9 张）
    const imagesToFetch = rawImageUrls.slice(0, 9);
    const images = [];

    await Promise.all(
      imagesToFetch.map(async (imgUrl) => {
        try {
          let fetchUrl = imgUrl;
          if (fetchUrl.includes("ci.xiaohongshu.com") || fetchUrl.includes("sns-img-qc.xhscdn.com")) {
            if (!fetchUrl.includes("?")) {
              fetchUrl += "?imageView2/2/w/800/format/jpg";
            }
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
        } catch (imgErr) {
          // 单张拉取失败跳过
        }
      })
    );

    const isMissingCore = !title || images.length === 0;

    const responsePayload = {
      ok: true,
      data: {
        title: title || "小红书笔记",
        desc: desc || "",
        author: author || "小红书用户",
        images,
        comments,
      },
    };

    // 如果未完整提取到标题或图片，附带调试诊断信息
    if (isMissingCore) {
      responsePayload.debug = {
        stateFound: !!stateData,
        stateMatchedKey: stateMatchedKey || "none",
        finalUrl,
        rawImageCountFound: rawImageUrls.length,
        debug_html: html.slice(0, 2000),
      };
    }

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: CORS_HEADERS,
    });
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
