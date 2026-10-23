/**
 * Example extension: block sleep-and-poll bash calls on process logs.
 *
 * Copy this file to ~/.pi/agent/extensions/bash-sleep-poll-blocker.ts.
 * Requires @aliou/sh.
 *
 * Even with pi-processes running, models fall back to the polling ritual:
 *
 *   sleep 60; tail -2 /tmp/pi-processes-XXXX/proc_YYYY-stdout.log 2>/dev/null; \
 *   tail -3 /tmp/pi-processes-XXXX/proc_YYYY-stderr.log 2>/dev/null
 *
 * The manager already watches every process and sends an exit notification
 * that starts a new turn, so sleeping is pure waste. This extension:
 *
 * - Records the stdout/stderr/combined log paths of every process started
 *   through the process tool in this session (from the start results).
 * - Parses bash calls with @aliou/sh and blocks any command that both
 *   sleeps and touches one of those log paths, including loops
 *   (`while ! grep -q READY <log>; do sleep 2; done; tail <log>`).
 * - Returns the block with the `terminate` hint, so the agent ends its turn
 *   after the blocked call instead of retrying. The exit notification wakes
 *   it when the process finishes.
 *
 * Reading a log without a sleep (a one-shot tail of current output) is left
 * alone. Commands that fail to parse fall back to a raw-text heuristic.
 */

import { dirname } from "node:path";

import { parse, type Statement } from "@aliou/sh";
import type {
  BashToolCallEvent,
  ExtensionAPI,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

interface ProcessStartDetails {
  process?: {
    id?: string;
    stdoutFile?: string;
    stderrFile?: string;
  };
}

/** True when the command's first literal word is `sleep`. */
function isSleepCommand(command: {
  words?: Array<{ parts?: Array<{ type?: string; value?: string }> }>;
}): boolean {
  const part = command.words?.[0]?.parts?.[0];
  return part?.type === "Literal" && part.value === "sleep";
}

/** Recursively look for a `sleep` invocation anywhere in an AST node. */
function containsSleep(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.type === "SimpleCommand" && isSleepCommand(n as never)) return true;
  for (const value of Object.values(n)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child && typeof child === "object" && containsSleep(child)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Sleep-poll detection result: the log paths (with owning process ids) the
 * command waits on.
 */
type SleepPoll = { path: string; processId: string }[] | null;
type LogHit = Exclude<SleepPoll, null>[number];

/**
 * Match a parsed command line against known log paths. Blocks when any
 * statement sleeps and any statement (or the same one, e.g. a wait loop)
 * reads a tracked log.
 */
function matchParsed(command: string, paths: Map<string, string>): SleepPoll {
  let body: Statement[];
  try {
    body = parse(command).ast.body ?? [];
  } catch {
    return null;
  }

  const statements = body.filter(
    (stmt) => stmt.pos && stmt.end,
  ) as Required<Statement>[];
  const sleeping = statements
    .filter((stmt) => containsSleep(stmt.command))
    .map((stmt) => command.slice(stmt.pos.offset, stmt.end.offset));
  if (sleeping.length === 0) return null;

  const hits: SleepPoll = [];
  for (const [path, processId] of paths) {
    const readsLog = statements.some((stmt) =>
      command.slice(stmt.pos.offset, stmt.end.offset).includes(path),
    );
    if (readsLog) hits.push({ path, processId });
  }
  return hits.length > 0 ? hits : null;
}

/** Fallback for unparseable commands: sleep + tracked path in the raw text. */
function matchRaw(command: string, paths: Map<string, string>): SleepPoll {
  if (!/\bsleep\s+\S/.test(command)) return null;
  const hits: SleepPoll = [];
  for (const [path, processId] of paths) {
    if (command.includes(path)) hits.push({ path, processId });
  }
  return hits.length > 0 ? hits : null;
}

function blockReason(hits: LogHit[]): string {
  const targets = hits
    .map((hit) => `- ${hit.path} (process ${hit.processId})`)
    .join("\n");
  return (
    "Blocked: this command sleeps before reading a managed process log:\n" +
    `${targets}\n\n` +
    "pi-processes watches that process and sends an exit notification as " +
    "soon as it finishes, which starts a new turn automatically. Do not " +
    "wait by sleeping: end your turn now and the notification will wake " +
    "you.\n\n" +
    "If you need current output right now, read the log once without a " +
    "sleep (or use the process tool), but do not poll."
  );
}

export default function bashSleepPollBlocker(pi: ExtensionAPI) {
  // Log path -> process id, for every process started this session.
  const logPaths = new Map<string, string>();

  const register = (path: string | undefined, processId: string): void => {
    if (path) logPaths.set(path, processId);
  };

  pi.on("tool_result", (event) => {
    if (event.toolName !== "process" || event.isError) return;
    const proc = (event.structuredContent as ProcessStartDetails | undefined)
      ?.process;
    if (!proc?.id) return;
    register(proc.stdoutFile, proc.id);
    register(proc.stderrFile, proc.id);
    if (proc.stdoutFile) {
      // The manager mirrors both streams into <dir>/<id>-combined.log.
      register(`${dirname(proc.stdoutFile)}/${proc.id}-combined.log`, proc.id);
    }
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const { command } = (event as BashToolCallEvent).input;
    const hits = matchParsed(command, logPaths) ?? matchRaw(command, logPaths);
    if (!hits) return;

    return {
      block: true,
      terminate: true,
      reason: blockReason(hits),
    } satisfies ToolCallEventResult;
  });
}
