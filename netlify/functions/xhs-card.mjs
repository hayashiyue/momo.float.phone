/**
 * xhs-card.mjs —— 小红书笔记抓取与图片 Base64 转换服务（Netlify Function）
 * 供小手机「小红书伴读插件」同源直接调用。
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

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
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

    // 1. 请求小红书页面（follow 自动跟踪短链 302 重定向）
    const pageRes = await fetch(targetUrl, {
      headers: {
        "User-Agent": mobileUA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh-Hans;q=0.9",
      },
      redirect: "follow",
    });

    const html = await pageRes.text();

    // 2. 从 HTML 源码解析 window.__INITIAL_STATE__
    let stateData = null;
    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\})<\/script>/s);

    if (stateMatch && stateMatch[1]) {
      try {
        const rawJson = stateMatch[1].replace(/undefined/g, "null");
        stateData = JSON.parse(rawJson);
      } catch (e) {
        // JSON 脏数据容错
      }
    }

    // 提取笔记信息
    let note = null;
    if (stateData && stateData.note && stateData.note.noteDetailMap) {
      const firstId = Object.keys(stateData.note.noteDetailMap)[0];
      note = stateData.note.noteDetailMap[firstId]?.note;
    } else if (stateData && stateData.noteData) {
      note = stateData.noteData;
    }

    let title = note?.title || "";
    let desc = note?.desc || "";
    let author = note?.user?.nickname || "";
    let rawImageUrls = [];

    if (note?.imageList && Array.isArray(note.imageList)) {
      rawImageUrls = note.imageList
        .map((img) => img.urlDefault || img.url || (img.infoList && img.infoList[0]?.url))
        .filter(Boolean);
    }

    // meta 标签降级容错
    if (!title) {
      const metaTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
      title = metaTitle ? metaTitle[1] : "小红书笔记";
    }
    if (!desc) {
      const metaDesc = html.match(/<meta name="description" content="([^"]+)"/);
      desc = metaDesc ? metaDesc[1] : "";
    }
    if (rawImageUrls.length === 0) {
      const metaImg = html.match(/<meta property="og:image" content="([^"]+)"/);
      if (metaImg && metaImg[1]) rawImageUrls.push(metaImg[1]);
    }

    // 提取前 5 条热评（若有）
    let comments = [];
    if (stateData && stateData.comment && stateData.comment.comments) {
      comments = stateData.comment.comments.slice(0, 5).map((c) => ({
        user: c.user?.nickname || "网友",
        content: c.content || "",
        likeCount: c.likeCount || 0,
      }));
    }

    // 3. 服务端并发拉取图片并转换为 Base64（限制最多转 3 张，绕过防盗链）
    const imagesToFetch = rawImageUrls.slice(0, 3);
    const images = [];

    await Promise.all(
      imagesToFetch.map(async (imgUrl) => {
        try {
          const imgRes = await fetch(imgUrl, {
            headers: {
              "User-Agent": mobileUA,
              "Referer": "https://www.xiaohongshu.com/",
            },
          });
          if (imgRes.ok) {
            const mime = imgRes.headers.get("content-type") || "image/jpeg";
            const buffer = await imgRes.arrayBuffer();
            const base64 = Buffer.from(buffer).toString("base64");
            images.push({
              dataUrl: `data:${mime};base64,${base64}`,
              url: imgUrl,
            });
          }
        } catch (imgErr) {
          // 单张图失败跳过
        }
      })
    );

    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          title: title.trim(),
          desc: desc.trim(),
          author: author || "小红书用户",
          images,
          comments,
        },
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message || "抓取失败" }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
