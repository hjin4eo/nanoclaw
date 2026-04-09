/**
 * Bare-Metal Runner for NanoClaw
 * Runs the agent-runner directly on the host without Docker/containers.
 * Replaces container-runner when BARE_METAL_MODE=true.
 *
 * Trade-offs vs container mode:
 * - No filesystem isolation: agent can access host paths
 * - No credential proxy: ANTHROPIC_API_KEY must be set in .env directly
 * - Sandboxing must be handled via allowed_directories in CLAUDE.md or external tools
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';

// Sentinel markers (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Path to the built agent-runner entry point.
 * Run `npm install && npm run build` inside container/agent-runner/ first.
 */
function resolveAgentRunnerPath(): string {
  const projectRoot = process.cwd();
  const distPath = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'dist',
    'index.js',
  );
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Agent runner not built. Run: cd container/agent-runner && npm install && npm run build`,
    );
  }
  return distPath;
}

function buildEnvForGroup(
  group: RegisteredGroup,
  isMain: boolean,
): NodeJS.ProcessEnv {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const globalDir = path.join(GROUPS_DIR, 'global');

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Ensure IPC directories exist
  const groupIpcInputDir = path.join(groupIpcDir, 'input');
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(groupIpcInputDir, { recursive: true });

  return {
    ...process.env,
    // Paths previously provided by Docker volume mounts
    NANOCLAW_IPC_DIR: groupIpcDir,
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_GLOBAL_DIR: fs.existsSync(globalDir) ? globalDir : '',
    // Claude Code config
    HOME: groupSessionsDir,
    TZ: TIMEZONE,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
    // Main group gets read access to the project root
    ...(isMain
      ? { NANOCLAW_PROJECT_DIR: projectRoot }
      : {}),
  };
}

export async function runBareMetalAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, runnerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const runnerPath = resolveAgentRunnerPath();
  const runnerName = `nanoclaw-bare-${group.folder}-${Date.now()}`;
  const env = buildEnvForGroup(group, input.isMain);

  logger.info(
    {
      group: group.name,
      runnerName,
      isMain: input.isMain,
      groupDir,
    },
    'Spawning bare-metal agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Optional: sandbox with firejail (Linux only)
  // Set BARE_METAL_SANDBOX_DIR to the project folder you want to restrict access to.
  // Requires: sudo apt install firejail
  const sandboxDir = process.env.BARE_METAL_SANDBOX_DIR;
  const useFirejail =
    sandboxDir && process.platform === 'linux' && !input.isMain;

  const [spawnCmd, spawnArgs] = useFirejail
    ? [
        'firejail',
        [
          '--quiet',
          `--whitelist=${sandboxDir}`,
          `--whitelist=${groupDir}`,
          `--read-only=/`,
          process.execPath,
          runnerPath,
        ],
      ]
    : [process.execPath, [runnerPath]];

  return new Promise((resolve) => {
    const proc = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: groupDir,
    });

    onProcess(proc, runnerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Bare-metal stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) newSessionId = parsed.newSessionId;
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ runner: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, runnerName }, 'Bare-metal agent timeout');
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          outputChain.then(() =>
            resolve({ status: 'success', result: null, newSessionId }),
          );
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Bare-metal agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr },
          'Bare-metal agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Bare-metal agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          { group: group.name, duration, status: output.status },
          'Bare-metal agent completed',
        );
        resolve(output);
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'Bare-metal agent spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}
