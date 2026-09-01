// rev-a2b81d-20260901 FileSystemTool.ts
import * as fs from 'fs';
import * as path from 'path';
import { ToolDefinition } from '../../schema/HermesTypes';

export interface FileSystemInput {
  operation: 'read' | 'write' | 'append' | 'list' | 'exists' | 'delete' | 'mkdir' | 'search';
  path: string;
  content?: string;
  encoding?: BufferEncoding;
  recursive?: boolean;
  pattern?: string;
  maxDepth?: number;
}

export interface FileSystemResult {
  success: boolean;
  data?: string | string[] | boolean;
  error?: string;
}

const BLOCKED_PATHS = [
  '/etc/passwd', '/etc/shadow', 'C:\\Windows\\System32',
  '/System/Library', '/proc/sys',
];

/**
 * FileSystemTool — read, write, list, search files and directories.
 * Runs in the main Electron process with Node.js fs access.
 */
export class FileSystemTool {
  private allowedPaths: string[];
  private maxFileSizeBytes: number;

  constructor(allowedPaths: string[] = [], maxFileSizeBytes = 10 * 1024 * 1024) {
    this.allowedPaths = allowedPaths.map((p) => path.resolve(p));
    this.maxFileSizeBytes = maxFileSizeBytes;
  }

  /** Tool definition for LLM function-calling. */
  static get definition(): ToolDefinition {
    return {
      name: 'filesystem',
      description:
        'Read, write, append, list, delete files and directories on the local file system. ' +
        'Use "list" to explore directory contents, "read" to get file content, ' +
        '"write" to create/overwrite a file, "search" to find files by name pattern.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['read', 'write', 'append', 'list', 'exists', 'delete', 'mkdir', 'search'],
            description: 'The file system operation to perform',
          },
          path: {
            type: 'string',
            description: 'Absolute or relative file/directory path',
          },
          content: {
            type: 'string',
            description: 'File content for write/append operations',
          },
          encoding: {
            type: 'string',
            description: 'Text encoding (default: utf8)',
          },
          recursive: {
            type: 'boolean',
            description: 'For list: recurse into subdirectories. For delete: remove non-empty dirs.',
          },
          pattern: {
            type: 'string',
            description: 'For search: glob-like filename pattern (e.g. "*.ts")',
          },
          maxDepth: {
            type: 'number',
            description: 'For list/search: max directory depth (default: 3)',
          },
        },
        required: ['operation', 'path'],
      },
    };
  }

  /** Main entry point — dispatched by ToolRegistry. */
  async execute(input: FileSystemInput): Promise<string> {
    const resolvedPath = path.resolve(input.path);

    this.checkBlocked(resolvedPath);

    switch (input.operation) {
      case 'read':    return this.read(resolvedPath, input.encoding ?? 'utf8');
      case 'write':   return this.write(resolvedPath, input.content ?? '');
      case 'append':  return this.append(resolvedPath, input.content ?? '');
      case 'list':    return this.list(resolvedPath, input.recursive ?? false, input.maxDepth ?? 3);
      case 'exists':  return this.exists(resolvedPath);
      case 'delete':  return this.delete(resolvedPath, input.recursive ?? false);
      case 'mkdir':   return this.mkdir(resolvedPath);
      case 'search':  return this.search(resolvedPath, input.pattern ?? '*', input.maxDepth ?? 3);
      default:
        throw new Error(`Unknown operation: ${(input as FileSystemInput).operation}`);
    }
  }

  private async read(filePath: string, encoding: BufferEncoding): Promise<string> {
    const stat = fs.statSync(filePath);
    if (stat.size > this.maxFileSizeBytes) {
      throw new Error(`File too large: ${stat.size} bytes (max ${this.maxFileSizeBytes})`);
    }
    return fs.readFileSync(filePath, encoding);
  }

  private async write(filePath: string, content: string): Promise<string> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return `Written ${content.length} characters to ${filePath}`;
  }

  private async append(filePath: string, content: string): Promise<string> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, content, 'utf8');
    return `Appended ${content.length} characters to ${filePath}`;
  }

  private async list(dirPath: string, recursive: boolean, maxDepth: number, depth = 0): Promise<string> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const lines: string[] = [];

    for (const entry of entries) {
      const indent = '  '.repeat(depth);
      const suffix = entry.isDirectory() ? '/' : '';
      lines.push(`${indent}${entry.name}${suffix}`);

      if (recursive && entry.isDirectory() && depth < maxDepth) {
        const sub = await this.list(path.join(dirPath, entry.name), true, maxDepth, depth + 1);
        lines.push(sub);
      }
    }

    return lines.join('\n');
  }

  private async exists(filePath: string): Promise<string> {
    return fs.existsSync(filePath) ? `exists: true (${filePath})` : `exists: false (${filePath})`;
  }

  private async delete(filePath: string, recursive: boolean): Promise<string> {
    if (!fs.existsSync(filePath)) return `Not found: ${filePath}`;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmdirSync(filePath, { recursive });
    } else {
      fs.unlinkSync(filePath);
    }
    return `Deleted: ${filePath}`;
  }

  private async mkdir(dirPath: string): Promise<string> {
    fs.mkdirSync(dirPath, { recursive: true });
    return `Created directory: ${dirPath}`;
  }

  private async search(dirPath: string, pattern: string, maxDepth: number, depth = 0): Promise<string> {
    if (!fs.existsSync(dirPath)) return `Directory not found: ${dirPath}`;
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
    const results: string[] = [];
    this.searchRecursive(dirPath, regex, maxDepth, depth, results);
    return results.length > 0 ? results.join('\n') : 'No files matched the pattern.';
  }

  private searchRecursive(
    dirPath: string,
    pattern: RegExp,
    maxDepth: number,
    depth: number,
    results: string[],
  ): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.searchRecursive(fullPath, pattern, maxDepth, depth + 1, results);
      } else if (pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  private checkBlocked(resolvedPath: string): void {
    for (const blocked of BLOCKED_PATHS) {
      if (resolvedPath.startsWith(blocked)) {
        throw new Error(`Access denied: path "${resolvedPath}" is blocked.`);
      }
    }
  }
}
