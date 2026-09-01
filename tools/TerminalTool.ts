// rev-a2b81d-20260901 TerminalTool.ts
import { spawn } from 'child_process';
import * as os from 'os';
import { ToolDefinition } from '../../schema/HermesTypes';

export interface TerminalInput {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  env?: Record<string, string>;
}

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/[^/]*/i,
  /format\s+[a-z]:/i,
  /del\s+\/f\s+\/s\s+\/q\s+[a-z]:\\/i,
  /mkfs\./i,
  /dd\s+.*of=\/dev\//i,
];

/**
 * TerminalTool — executes shell commands in a sandboxed subprocess.
 * Blocks known destructive patterns. Captures stdout + stderr.
 */
export class TerminalTool {
  private defaultTimeoutSeconds: number;
  private defaultCwd: string;

  constructor(defaultTimeoutSeconds = 30, defaultCwd = os.homedir()) {
    this.defaultTimeoutSeconds = defaultTimeoutSeconds;
    this.defaultCwd = defaultCwd;
  }

  static get definition(): ToolDefinition {
    return {
      name: 'terminal',
      description:
        'Execute a shell command and return stdout/stderr output. ' +
        'Use for running scripts, installing packages, checking system info, file operations. ' +
        'Commands are run in a subprocess; long-running commands are killed after timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the command (default: user home)',
          },
          timeoutSeconds: {
            type: 'number',
            description: 'Timeout in seconds before the process is killed (default: 30)',
          },
          env: {
            type: 'object',
            description: 'Additional environment variables to set',
          },
        },
        required: ['command'],
      },
      dangerous: true,
    };
  }

  async execute(input: TerminalInput): Promise<string> {
    this.checkBlocked(input.command);

    const timeout = (input.timeoutSeconds ?? this.defaultTimeoutSeconds) * 1000;
    const cwd = input.cwd ?? this.defaultCwd;
    const env = { ...process.env, ...(input.env ?? {}) };

    return new Promise<string>((resolve, reject) => {
      const isWindows = os.platform() === 'win32';
      const shell = isWindows ? 'cmd' : '/bin/sh';
      const shellFlag = isWindows ? '/c' : '-c';

      const proc = spawn(shell, [shellFlag, input.command], {
        cwd,
        env,
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        // Cap output at 50 KB to prevent memory issues
        if (stdout.length > 51200) stdout = '[...truncated...]\n' + stdout.slice(-20480);
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 51200) stderr = '[...truncated...]\n' + stderr.slice(-20480);
      });

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Command timed out after ${input.timeoutSeconds ?? this.defaultTimeoutSeconds}s`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const output = [
          stdout.trim() ? `STDOUT:\n${stdout.trim()}` : '',
          stderr.trim() ? `STDERR:\n${stderr.trim()}` : '',
          `Exit code: ${code}`,
        ]
          .filter(Boolean)
          .join('\n\n');
        resolve(output || `Command completed with exit code ${code}`);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private checkBlocked(command: string): void {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(
          `Command blocked: matches dangerous pattern. Command: "${command.slice(0, 80)}"`,
        );
      }
    }
  }
}
