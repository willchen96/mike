type OlostepModule = typeof import("olostep");

let cachedModule: OlostepModule | null | undefined;

async function loadOlostep(): Promise<OlostepModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  try {
    cachedModule = await import("olostep");
    return cachedModule;
  } catch {
    cachedModule = null;
    return null;
  }
}

const apiKey = process.env.OLOSTEP_API_KEY ?? "";

/**
 * Fetches clean Markdown content from a URL using the Olostep scrape API.
 * Returns the markdown string on success, or a string starting with "Error:" on failure.
 */
export async function scrapeUrl(url: string): Promise<string> {
  const olostepModule = await loadOlostep();
  if (!olostepModule) {
    return "Error: Olostep is not installed. Install it with: npm install olostep";
  }

  if (!apiKey) {
    return "Error: OLOSTEP_API_KEY is not configured in environment.";
  }

  try {
    const { default: Olostep, Format } = olostepModule;
    const client = new Olostep({ apiKey });
    const result = await client.scrapes.create({
      url,
      formats: [Format.MARKDOWN],
      removeImages: true,
    });

    return (
      result.markdown_content ?? "Error: Olostep returned no markdown content."
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

/**
 * Fetches clean HTML content from a URL using the Olostep scrape API.
 * Returns the html string on success, or a string starting with "Error:" on failure.
 */
export async function scrapeUrlHtml(url: string): Promise<string> {
  const olostepModule = await loadOlostep();
  if (!olostepModule) {
    return "Error: Olostep is not installed. Install it with: npm install olostep";
  }

  if (!apiKey) {
    return "Error: OLOSTEP_API_KEY is not configured in environment.";
  }

  try {
    const { default: Olostep, Format } = olostepModule;
    const client = new Olostep({ apiKey });
    const result = await client.scrapes.create({
      url,
      formats: [Format.HTML],
    });

    return result.html_content ?? "Error: Olostep returned no HTML content.";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

/**
 * Uses Olostep's AI-powered answers endpoint to search and extract information from a URL.
 * Returns structured answer with sources on success, or a string starting with "Error:" on failure.
 */
export async function answerQuestion(
  url: string,
  question: string,
): Promise<{ answer: string; sources: string[] } | { error: string }> {
  const olostepModule = await loadOlostep();
  if (!olostepModule) {
    return {
      error: "Olostep is not installed. Install it with: npm install olostep",
    };
  }

  if (!apiKey) {
    return { error: "OLOSTEP_API_KEY is not configured in environment." };
  }

  try {
    const { default: Olostep } = olostepModule;
    const client = new Olostep({ apiKey });
    const task = `${question}\n\nContext URL: ${url}`;
    const result = await client.answers.create(task);

    return {
      answer: result.answer ?? "",
      sources: result.sources ?? [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Error: ${msg}` };
  }
}

/**
 * Crawls a website starting from a URL, following links up to maxPages and maxDepth.
 * Returns crawl job ID for async tracking.
 */
export async function crawlWebsite(
  url: string,
  maxPages: number = 50,
  maxDepth: number = 2,
): Promise<{ crawlId: string } | { error: string }> {
  const olostepModule = await loadOlostep();
  if (!olostepModule) {
    return {
      error: "Olostep is not installed. Install it with: npm install olostep",
    };
  }

  if (!apiKey) {
    return { error: "OLOSTEP_API_KEY is not configured in environment." };
  }

  try {
    const { default: Olostep } = olostepModule;
    const client = new Olostep({ apiKey });
    const crawl = await client.crawls.create({
      url,
      maxPages,
      maxDepth,
    });

    return { crawlId: crawl.id };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Error: ${msg}` };
  }
}

/**
 * Maps/indexes URLs from a website using Olostep's site mapping API.
 * Returns up to topN most relevant URLs based on optional search query.
 */
export async function mapSiteUrls(
  url: string,
  topN: number = 50,
  searchQuery?: string,
): Promise<string[] | { error: string }> {
  const olostepModule = await loadOlostep();
  if (!olostepModule) {
    return {
      error: "Olostep is not installed. Install it with: npm install olostep",
    };
  }

  if (!apiKey) {
    return { error: "OLOSTEP_API_KEY is not configured in environment." };
  }

  try {
    const { default: Olostep } = olostepModule;
    const client = new Olostep({ apiKey });
    const map = await client.maps.create({
      url,
      topN,
      searchQuery,
      includeSubdomain: true,
    });

    const urls: string[] = [];
    for await (const pageUrl of map.urls()) {
      urls.push(pageUrl);
    }
    return urls;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Error: ${msg}` };
  }
}
