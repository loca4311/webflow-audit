// audit-images.js
// Usage: node audit-images.js <siteBaseUrl> [sitemapUrl]
// Requires:
//   npm i got@11.8.6 cheerio@1.0.0-rc.12 probe-image-size@7 p-limit@3 xml2js@0.5.0 @notionhq/client

const fs = require("fs");
const path = require("path");
const got = require("got");
const cheerio = require("cheerio");
const probe = require("probe-image-size");
const pLimit = require("p-limit");
const { parseStringPromise } = require("xml2js");
const { Client: NotionClient } = require("@notionhq/client");

const BASE_CONCURRENCY = 6;
const USER_AGENT = "Mozilla/5.0 (compatible; ImageAuditBot/1.0)";
const TOO_LARGE_BYTES = 500 * 1024; // 500 KB

// -------------------- Notion init --------------------

function initNotion() {
  let apiKey = process.env.NOTION_API_KEY || null;
  let parentPageId = process.env.NOTION_PARENT_PAGE_ID || null;

  if (!apiKey || !parentPageId) {
    try {
      const localConfig = require("./config.local.js");
      apiKey = apiKey || localConfig.NOTION_API_KEY;
      parentPageId = parentPageId || localConfig.NOTION_PARENT_PAGE_ID;
    } catch {
      // ignore, we'll just skip Notion sync
    }
  }

  if (!apiKey || !parentPageId) {
    console.log(
      "Notion credentials not found (NOTION_API_KEY / NOTION_PARENT_PAGE_ID). Notion sync will be skipped."
    );
    return { notion: null, parentPageId: null };
  }

  const notion = new NotionClient({ auth: apiKey });
  return { notion, parentPageId };
}

// -------------------- Helpers --------------------

function normalizeUrl(pageUrl, maybeRel) {
  try {
    if (!maybeRel) return null;
    const s = String(maybeRel)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!s) return null;
    return new URL(s, pageUrl).toString();
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    const res = await got(url, {
      timeout: 15000,
      retry: 0,
      headers: { "user-agent": USER_AGENT },
    });
    return res.body;
  } catch {
    return null;
  }
}

async function getSitemapUrls(sitemapUrl) {
  try {
    const xml = await got(sitemapUrl, {
      timeout: 15000,
      retry: 0,
      headers: { "user-agent": USER_AGENT },
    }).text();
    const parsed = await parseStringPromise(xml);
    const urls = [];
    if (parsed.urlset?.url) {
      for (const u of parsed.urlset.url) {
        if (u.loc && u.loc[0]) urls.push(u.loc[0]);
      }
    } else if (parsed.sitemapindex?.sitemap) {
      for (const s of parsed.sitemapindex.sitemap) {
        if (s.loc && s.loc[0]) {
          const nested = await getSitemapUrls(s.loc[0]);
          urls.push(...nested);
        }
      }
    }
    return [...new Set(urls)];
  } catch {
    return [];
  }
}

/**
 * Collect all image-like URLs directly from HTML.
 */
function collectImageUrlsFromHtml(html) {
  const $ = cheerio.load(html);
  const imgs = new Set();

  // <img src / srcset>
  $("img").each((i, el) => {
    const src = $(el).attr("src");
    if (src) imgs.add(src);

    const srcset = $(el).attr("srcset");
    if (srcset) {
      srcset.split(",").forEach((part) => {
        const url = part.trim().split(/\s+/)[0];
        if (url) imgs.add(url);
      });
    }
  });

  // <picture> <source srcset/src>
  $("picture source").each((i, el) => {
    const ss = $(el).attr("srcset");
    if (ss) {
      ss.split(",").forEach((part) => {
        const url = part.trim().split(/\s+/)[0];
        if (url) imgs.add(url);
      });
    }
    const s = $(el).attr("src");
    if (s) imgs.add(s);
  });

  // Inline styles: background-image: url(...)
  $("[style]").each((i, el) => {
    const style = $(el).attr("style");
    const re = /url\(([^)]+)\)/gi;
    let m;
    while ((m = re.exec(style))) {
      const url = m[1]?.trim().replace(/^['"]|['"]$/g, "");
      if (url) imgs.add(url);
    }
  });

  // meta / open-graph images
  $('meta[property="og:image"], meta[name="twitter:image"]').each((i, el) => {
    const url = $(el).attr("content");
    if (url) imgs.add(url);
  });

  return [...imgs];
}

function containsUnencodedSpaces(url) {
  return /\s/.test(String(url || ""));
}

/**
 * Inspect image by HEAD request only.
 * Returns { ok, statusCode, length }.
 */
async function inspectImage(url, refererPage) {
  const headers = {
    "user-agent": USER_AGENT,
    accept: "image/avif,image/webp,image/*,*/*;q=0.8",
    referer: refererPage,
  };

  try {
    const res = await got.head(url, {
      timeout: 15000,
      retry: 0,
      headers,
      throwHttpErrors: false, // важливо: не кидати помилку на 4xx/5xx
    });

    const lenHeader = res.headers["content-length"];
    const length = lenHeader ? parseInt(lenHeader, 10) : null;

    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      statusCode: res.statusCode,
      length,
    };
  } catch (e) {
    return {
      ok: false,
      statusCode: e.response?.statusCode || null,
      length: null,
    };
  }
}

/**
 * Build base report file name: "report-YYYY-MM-DD-HH-MM-SS"
 * Also used as Notion DB title.
 */
function getReportBaseName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");

  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());

  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  const ss = pad(now.getSeconds());

  return `report-${yyyy}-${mm}-${dd}-${hh}-${min}-${ss}`;
}

// -------------------- Notion sync: issues in one DB --------------------

/**
 * Create a Notion database for this audit and insert all issues
 * (broken images + oversized images) into it.
 *
 * Columns:
 *  - Name (title) – page title
 *  - Page Link (url)
 *  - Broken image url (url)
 *  - Oversized Image (url)
 *  - Image Size (number, KB)
 *  - Image (files, external)
 *  - Issue Type (select: "Broken Image Url" | "Oversized Image")
 */
async function syncIssuesToNotionDatabase(
  issues,
  notion,
  parentPageId,
  dbTitle
) {
  if (!notion || !parentPageId) {
    console.log("Notion client not configured. Skipping Notion sync.");
    return;
  }

  if (!issues.length) {
    console.log("No issues found. Skipping Notion sync.");
    return;
  }

  console.log(
    `Preparing Notion database for issues. Total issues: ${issues.length}`
  );

  // 1) Create database (table) under the parent page
  let db;
  try {
    db = await notion.databases.create({
      parent: {
        type: "page_id",
        page_id: parentPageId,
      },
      title: [
        {
          type: "text",
          text: { content: dbTitle },
        },
      ],
      // порядок полів задаємо префіксами 1,2,3...
      initial_data_source: {
        properties: {
          Name: { title: {} },
          "1 Page Link": { url: {} },
          "2 Issue Type": { select: {} },
          "3 Broken image url": { url: {} },
          "4 Oversized Image": { url: {} },
          "5 Image": { files: {} },
          "6 Image Size": { number: { format: "number" } },
        },
      },
    });

    console.log("Notion database created:", db.id);
  } catch (err) {
    console.error("Failed to create Notion database:", err.message || err);
    return;
  }

  const dataSourceId =
    db.data_sources && db.data_sources[0] && db.data_sources[0].id;

  if (!dataSourceId) {
    console.warn(
      "No data source ID returned for the new database. Cannot add rows."
    );
    return;
  }

  const limitNotion = pLimit(3);

  await Promise.all(
    issues.map((issue) =>
      limitNotion(async () => {
        const pageUrl = issue.page || "";
        const brokenUrl = issue.brokenImageUrl || null;
        const oversizedUrl = issue.oversizedImageUrl || null;
        const sizeKB = issue.imageSizeKB ?? null;
        const pageTitle = issue.pageTitle || pageUrl.slice(0, 60) || "Page";

        const filesValue = oversizedUrl
          ? [
              {
                type: "external",
                name: "Image",
                external: { url: oversizedUrl },
              },
            ]
          : [];

        try {
          await notion.pages.create({
            parent: {
              type: "data_source_id",
              data_source_id: dataSourceId,
            },
            properties: {
              Name: {
                title: [
                  {
                    type: "text",
                    text: { content: pageTitle },
                  },
                ],
              },
              "1 Page Link": {
                url: pageUrl || null,
              },
              "2 Issue Type": {
                select: issue.issueType ? { name: issue.issueType } : null,
              },
              "3 Broken image url": {
                url: brokenUrl,
              },
              "4 Oversized Image": {
                url: oversizedUrl,
              },
              "5 Image": {
                files: filesValue,
              },
              "6 Image Size": {
                number: sizeKB,
              },
            },
          });
        } catch (e) {
          console.warn(
            "Failed to create Notion row for:",
            pageUrl,
            "Error:",
            e.message || e
          );
        }
      })
    )
  );

  console.log("Notion sync (issues database) completed.");
}

// -------------------- Main crawl --------------------

(async () => {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.log("Usage: node audit-images.js <siteBaseUrl> [sitemapUrl]");
    process.exit(1);
  }

  const baseUrl = args[0].replace(/\/$/, "");
  const sitemapArg = args[1] || `${baseUrl}/sitemap.xml`;

  console.log("Base URL:", baseUrl);
  console.log("Using sitemap:", sitemapArg);

  const { notion, parentPageId } = initNotion();

  let pages = await getSitemapUrls(sitemapArg);
  if (!pages.length) {
    console.warn(
      "No sitemap entries found. Falling back to single-level crawl from base URL."
    );
    const html = await fetchText(baseUrl);
    if (!html) {
      console.error(
        "Failed to load base URL. Please check the site or provide a valid sitemap URL."
      );
      process.exit(1);
    }
    const $ = cheerio.load(html);
    const links = new Set([baseUrl]);
    $("a[href]").each((i, el) => {
      const href = $(el).attr("href");
      const abs = normalizeUrl(baseUrl, href);
      if (abs && abs.startsWith(baseUrl)) links.add(abs.split("#")[0]);
    });
    pages = [...links];
  }

  console.log(`Pages found: ${pages.length}`);
  const limit = pLimit(BASE_CONCURRENCY);
  const issues = [];
  let totalImagesChecked = 0;
  let imagesWithSizeKnown = 0;
  let oversizedImagesFound = 0;

  for (const pageUrl of pages) {
    try {
      console.log("Scanning page:", pageUrl);
      const html = await fetchText(pageUrl);
      if (!html) {
        console.warn("Failed to load page:", pageUrl);
        continue;
      }

      const $page = cheerio.load(html);
      const pageTitle = $page("title").first().text().trim() || pageUrl;

      const imgUrls = collectImageUrlsFromHtml(html);
      const uniqueImgs = [...new Set(imgUrls)];

      await Promise.all(
        uniqueImgs.map((rawUrl) =>
          limit(async () => {
            const hasSpaces = containsUnencodedSpaces(rawUrl);

            // use absolute URL for network requests
            const absUrl = normalizeUrl(pageUrl, rawUrl) || rawUrl;

            let inspectRes = { ok: true, length: null };

            if (!hasSpaces) {
              try {
                inspectRes = await inspectImage(absUrl, pageUrl);
              } catch {
                inspectRes = { ok: false, length: null };
              }
            }

            totalImagesChecked++;

            if (typeof inspectRes.length === "number") {
              imagesWithSizeKnown++;
            }

            const isBroken = hasSpaces || !inspectRes.ok;
            const isOversized =
              inspectRes.ok &&
              typeof inspectRes.length === "number" &&
              inspectRes.length > TOO_LARGE_BYTES;

            if (isOversized) {
              oversizedImagesFound++;
            }

            if (!isBroken && !isOversized) return;

            const sizeKB =
              inspectRes.length != null
                ? Math.round(inspectRes.length / 1024)
                : null;

            let issueType;
            let brokenImageUrl = null;
            let oversizedImageUrl = null;

            if (isBroken) {
              issueType = "Broken Image Url";
              // For broken we keep EXACT raw URL (with spaces etc.)
              brokenImageUrl = rawUrl;
            } else if (isOversized) {
              issueType = "Oversized Image";
              oversizedImageUrl = absUrl;
            }

            issues.push({
              page: pageUrl,
              pageTitle,
              brokenImageUrl,
              oversizedImageUrl,
              imageSizeKB: isOversized ? sizeKB : null,
              issueType,
            });
          })
        )
      );
    } catch (e) {
      console.warn("Error while processing page:", pageUrl, "-", e.message);
    }
  }

  console.log("=== Image stats ===");
  console.log("Total images checked:", totalImagesChecked);
  console.log("Images with known size:", imagesWithSizeKnown);
  console.log("Oversized images found (> 500KB):", oversizedImagesFound);
  console.log("===================");

  const reportBase = getReportBaseName();
  const runIso = new Date().toISOString();

  // --- ensure reports directory exists ---
  const reportsDir = path.join(process.cwd(), "reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // --- Save CSV (basic export, можна потім розширити під Notion-поля) ---
  const csvFile = path.join(reportsDir, `${reportBase}.csv`);

  const head = [
    "Page Link",
    "Broken image url",
    "Oversized Image",
    "Image Size (KB)",
    "Issue Type",
  ];
  const rows = [head.join(",")];

  for (const r of issues) {
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    rows.push(
      [
        esc(r.page),
        esc(r.brokenImageUrl),
        esc(r.oversizedImageUrl),
        esc(r.imageSizeKB),
        esc(r.issueType),
      ].join(",")
    );
  }

  fs.writeFileSync(csvFile, rows.join("\n"), "utf8");
  console.log(`CSV report saved to: ${csvFile}`);

  // --- Save JSON ---
  const jsonFile = path.join(reportsDir, `${reportBase}.json`);
  const jsonPayload = {
    baseUrl,
    sitemap: sitemapArg,
    generatedAt: runIso,
    issuesCount: issues.length,
    issues,
  };
  fs.writeFileSync(jsonFile, JSON.stringify(jsonPayload, null, 2), "utf8");
  console.log(`JSON report saved to: ${jsonFile}`);
  console.log(`Total issues found: ${issues.length}`);

  // --- Sync to Notion ---
  await syncIssuesToNotionDatabase(
    issues,
    notion,
    parentPageId,
    reportBase // DB name
  );
})();
