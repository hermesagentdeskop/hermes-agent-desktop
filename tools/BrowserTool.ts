// rev-a2b81d-20260901 BrowserTool.ts
import { ToolDefinition } from '../../schema/HermesTypes';

export interface BrowserInput {
  action: 'navigate' | 'click' | 'type' | 'extract' | 'screenshot' | 'scroll' | 'close';
  url?: string;
  selector?: string;
  text?: string;
  scrollY?: number;
  waitForSelector?: string;
  waitMs?: number;
}

/**
 * BrowserTool — headless browser automation via Playwright (chromium).
 * Provides navigate/click/type/extract/screenshot actions for web automation.
 *
 * Playwright must be installed: `npm install playwright` + `npx playwright install chromium`
 */
export class BrowserTool {
  private browser: BrowserInstance | null = null;
  private page: PageInstance | null = null;
  private timeoutMs: number;
  private userAgent: string;

  // Lazy-load playwright to avoid startup cost when browser tool is unused
  private playwright: PlaywrightModule | null = null;

  constructor(timeoutMs = 30000, userAgent?: string) {
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent ?? 'Mozilla/5.0 (compatible; HermesAgent/0.9)';
  }

  static get definition(): ToolDefinition {
    return {
      name: 'browser',
      description:
        'Control a headless Chromium browser. Navigate to URLs, click elements, fill forms, ' +
        'extract page content, or take screenshots. Use for web scraping and browser automation.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['navigate', 'click', 'type', 'extract', 'screenshot', 'scroll', 'close'],
            description: 'The browser action to perform',
          },
          url: {
            type: 'string',
            description: 'URL to navigate to (required for navigate action)',
          },
          selector: {
            type: 'string',
            description: 'CSS selector for the target element',
          },
          text: {
            type: 'string',
            description: 'Text to type into the element',
          },
          scrollY: {
            type: 'number',
            description: 'Pixels to scroll vertically',
          },
          waitForSelector: {
            type: 'string',
            description: 'Wait for this CSS selector to appear before returning',
          },
          waitMs: {
            type: 'number',
            description: 'Wait this many milliseconds after action',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: BrowserInput): Promise<string> {
    switch (input.action) {
      case 'navigate':  return this.navigate(input);
      case 'click':     return this.click(input);
      case 'type':      return this.type(input);
      case 'extract':   return this.extract(input);
      case 'screenshot':return this.screenshot(input);
      case 'scroll':    return this.scroll(input);
      case 'close':     return this.close();
      default:
        throw new Error(`Unknown browser action: ${(input as BrowserInput).action}`);
    }
  }

  private async ensureBrowser(): Promise<void> {
    if (!this.playwright) {
      // Dynamic import so the rest of the app loads even without playwright installed
      this.playwright = await import('playwright') as unknown as PlaywrightModule;
    }
    if (!this.browser) {
      this.browser = await this.playwright.chromium.launch({ headless: true }) as BrowserInstance;
    }
    if (!this.page) {
      const ctx = await this.browser.newContext({ userAgent: this.userAgent });
      this.page = await ctx.newPage() as PageInstance;
      this.page.setDefaultTimeout(this.timeoutMs);
    }
  }

  private async navigate(input: BrowserInput): Promise<string> {
    if (!input.url) throw new Error('navigate requires a url');
    await this.ensureBrowser();
    await this.page!.goto(input.url, { waitUntil: 'domcontentloaded' });
    if (input.waitForSelector) await this.page!.waitForSelector(input.waitForSelector);
    if (input.waitMs) await this.wait(input.waitMs);
    const title = await this.page!.title();
    return `Navigated to: ${input.url}\nPage title: ${title}`;
  }

  private async click(input: BrowserInput): Promise<string> {
    if (!input.selector) throw new Error('click requires a selector');
    await this.ensureBrowser();
    await this.page!.click(input.selector);
    if (input.waitMs) await this.wait(input.waitMs);
    return `Clicked element: ${input.selector}`;
  }

  private async type(input: BrowserInput): Promise<string> {
    if (!input.selector) throw new Error('type requires a selector');
    if (input.text === undefined) throw new Error('type requires text');
    await this.ensureBrowser();
    await this.page!.fill(input.selector, input.text);
    return `Typed "${input.text}" into ${input.selector}`;
  }

  private async extract(input: BrowserInput): Promise<string> {
    await this.ensureBrowser();
    if (input.selector) {
      const text = await this.page!.innerText(input.selector);
      return text.slice(0, 8000);  // cap output
    }
    // No selector — return full page text
    const text = await this.page!.innerText('body');
    return text.slice(0, 8000);
  }

  private async screenshot(_input: BrowserInput): Promise<string> {
    await this.ensureBrowser();
    const buffer = await this.page!.screenshot({ type: 'png', fullPage: false });
    const b64 = buffer.toString('base64');
    return `Screenshot captured (base64 PNG, ${b64.length} chars). Data: data:image/png;base64,${b64.slice(0, 100)}...`;
  }

  private async scroll(input: BrowserInput): Promise<string> {
    await this.ensureBrowser();
    const scrollY = input.scrollY ?? 500;
    await this.page!.evaluate((y: number) => window.scrollBy(0, y), scrollY);
    if (input.waitMs) await this.wait(input.waitMs);
    return `Scrolled by ${scrollY}px`;
  }

  private async close(): Promise<string> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
    return 'Browser closed.';
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Minimal type stubs so the file compiles without playwright being installed at dev time
interface PlaywrightModule {
  chromium: { launch(opts: object): Promise<BrowserInstance> };
}
interface BrowserInstance {
  newContext(opts: object): Promise<{ newPage(): Promise<PageInstance> }>;
  close(): Promise<void>;
}
interface PageInstance {
  goto(url: string, opts?: object): Promise<void>;
  title(): Promise<string>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  innerText(selector: string): Promise<string>;
  screenshot(opts: object): Promise<Buffer>;
  evaluate<T>(fn: (arg: T) => void, arg: T): Promise<void>;
  waitForSelector(selector: string): Promise<void>;
  setDefaultTimeout(ms: number): void;
}
