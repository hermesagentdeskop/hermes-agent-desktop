// rev-a2b81d-20260901 WebSearchTool.ts
import https from 'https';
import { ToolDefinition } from '../../schema/HermesTypes';

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  region?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * WebSearchTool — performs web searches using the DuckDuckGo Instant Answer API.
 * Falls back to DuckDuckGo HTML scraping for regular results.
 * No API key required.
 */
export class WebSearchTool {
  private maxResults: number;
  private timeoutMs: number;

  constructor(maxResults = 5, timeoutMs = 10000) {
    this.maxResults = maxResults;
    this.timeoutMs = timeoutMs;
  }

  static get definition(): ToolDefinition {
    return {
      name: 'websearch',
      description:
        'Search the web for information. Returns titles, URLs, and snippets from search results. ' +
        'Use for finding current information, documentation, news, or any topic that requires web lookup.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5, max: 10)',
          },
          region: {
            type: 'string',
            description: 'Region code for localised results (e.g. "us-en", "uk-en")',
          },
        },
        required: ['query'],
      },
    };
  }

  async execute(input: WebSearchInput): Promise<string> {
    const limit = Math.min(input.maxResults ?? this.maxResults, 10);
    const results = await this.search(input.query, limit, input.region ?? 'wt-wt');

    if (results.length === 0) {
      return `No results found for: "${input.query}"`;
    }

    return results
      .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
      .join('\n\n');
  }

  private async search(query: string, limit: number, region: string): Promise<SearchResult[]> {
    // First try DuckDuckGo Instant Answer JSON API
    try {
      const instant = await this.ddgInstant(query);
      if (instant.length > 0) return instant.slice(0, limit);
    } catch {
      // fall through
    }

    // Fallback: DuckDuckGo HTML endpoint (lite version)
    return this.ddgHtml(query, limit, region);
  }

  private ddgInstant(query: string): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const req = https.get(url, { timeout: this.timeoutMs }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const results: SearchResult[] = [];

            // Abstract (top result)
            if (data.AbstractText) {
              results.push({
                title: data.Heading || query,
                url: data.AbstractURL || '',
                snippet: data.AbstractText,
              });
            }

            // Related topics
            for (const topic of (data.RelatedTopics ?? []).slice(0, 8)) {
              if (topic.Text && topic.FirstURL) {
                results.push({
                  title: topic.Text.split(' - ')[0] ?? topic.Text,
                  url: topic.FirstURL,
                  snippet: topic.Text,
                });
              }
            }

            resolve(results);
          } catch {
            reject(new Error('Failed to parse DDG instant answer response'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  private ddgHtml(query: string, limit: number, region: string): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
      const body = `q=${encodeURIComponent(query)}&kl=${region}`;
      const options = {
        hostname: 'html.duckduckgo.com',
        path: '/html/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Mozilla/5.0 (compatible; HermesAgent/0.9)',
        },
        timeout: this.timeoutMs,
      };

      const req = https.request(options, (res) => {
        let html = '';
        res.on('data', (chunk: Buffer) => (html += chunk));
        res.on('end', () => {
          resolve(this.parseHtmlResults(html, limit));
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.write(body);
      req.end();
    });
  }

  private parseHtmlResults(html: string, limit: number): SearchResult[] {
    const results: SearchResult[] = [];
    // Simple regex extraction — DDG HTML lite is stable enough for this
    const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
    const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([^<]+)<\/a>/g;

    const urls: Array<{ url: string; title: string }> = [];
    let m: RegExpExecArray | null;

    while ((m = resultPattern.exec(html)) !== null && urls.length < limit) {
      urls.push({ url: m[1], title: m[2] });
    }

    const snippets: string[] = [];
    while ((m = snippetPattern.exec(html)) !== null && snippets.length < limit) {
      snippets.push(m[1]);
    }

    for (let i = 0; i < Math.min(urls.length, limit); i++) {
      results.push({
        title: urls[i].title.trim(),
        url: urls[i].url,
        snippet: (snippets[i] ?? '').trim(),
      });
    }

    return results;
  }
}
