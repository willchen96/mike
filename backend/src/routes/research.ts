import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  scrapeUrl,
  scrapeUrlHtml,
  answerQuestion,
  crawlWebsite,
  mapSiteUrls,
} from "../lib/olostep";

export const researchRouter = Router();

// POST /api/research/scrape
// Fetch clean Markdown content from a URL
researchRouter.post("/scrape", requireAuth, async (req, res) => {
  const { url } = req.body as { url?: unknown };

  if (typeof url !== "string" || !url.trim()) {
    return void res.status(400).json({ error: "url is required" });
  }

  const normalizedUrl = url.trim();
  if (
    !normalizedUrl.startsWith("http://") &&
    !normalizedUrl.startsWith("https://")
  ) {
    return void res
      .status(400)
      .json({ error: "url must start with http:// or https://" });
  }

  try {
    const content = await scrapeUrl(normalizedUrl);

    if (content.startsWith("Error:")) {
      return void res.status(500).json({ error: content });
    }

    return void res.status(200).json({ content });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return void res.status(500).json({ error: message });
  }
});

// POST /api/research/search
// Ask AI-powered questions about a URL's content
researchRouter.post("/search", requireAuth, async (req, res) => {
  const { url, question } = req.body as {
    url?: unknown;
    question?: unknown;
  };

  if (typeof url !== "string" || !url.trim()) {
    return void res.status(400).json({ error: "url is required" });
  }

  if (typeof question !== "string" || !question.trim()) {
    return void res.status(400).json({ error: "question is required" });
  }

  const normalizedUrl = url.trim();
  if (
    !normalizedUrl.startsWith("http://") &&
    !normalizedUrl.startsWith("https://")
  ) {
    return void res
      .status(400)
      .json({ error: "url must start with http:// or https://" });
  }

  try {
    const result = await answerQuestion(normalizedUrl, question.trim());

    if ("error" in result) {
      return void res.status(500).json({ error: result.error });
    }

    return void res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return void res.status(500).json({ error: message });
  }
});

// POST /api/research/crawl
// Start crawling a website
researchRouter.post("/crawl", requireAuth, async (req, res) => {
  const { url, maxPages, maxDepth } = req.body as {
    url?: unknown;
    maxPages?: unknown;
    maxDepth?: unknown;
  };

  if (typeof url !== "string" || !url.trim()) {
    return void res.status(400).json({ error: "url is required" });
  }

  const normalizedUrl = url.trim();
  if (
    !normalizedUrl.startsWith("http://") &&
    !normalizedUrl.startsWith("https://")
  ) {
    return void res
      .status(400)
      .json({ error: "url must start with http:// or https://" });
  }

  const pages =
    typeof maxPages === "number" && maxPages > 0 ? maxPages : 50;
  const depth =
    typeof maxDepth === "number" && maxDepth > 0 ? maxDepth : 2;

  try {
    const result = await crawlWebsite(normalizedUrl, pages, depth);

    if ("error" in result) {
      return void res.status(500).json({ error: result.error });
    }

    return void res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return void res.status(500).json({ error: message });
  }
});

// POST /api/research/map
// Map/index URLs on a website
researchRouter.post("/map", requireAuth, async (req, res) => {
  const { url, topN, searchQuery } = req.body as {
    url?: unknown;
    topN?: unknown;
    searchQuery?: unknown;
  };

  if (typeof url !== "string" || !url.trim()) {
    return void res.status(400).json({ error: "url is required" });
  }

  const normalizedUrl = url.trim();
  if (
    !normalizedUrl.startsWith("http://") &&
    !normalizedUrl.startsWith("https://")
  ) {
    return void res
      .status(400)
      .json({ error: "url must start with http:// or https://" });
  }

  const n = typeof topN === "number" && topN > 0 ? topN : 50;
  const query = typeof searchQuery === "string" ? searchQuery : undefined;

  try {
    const result = await mapSiteUrls(normalizedUrl, n, query);

    if ("error" in result) {
      return void res.status(500).json({ error: result.error });
    }

    return void res.status(200).json({ urls: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return void res.status(500).json({ error: message });
  }
});
