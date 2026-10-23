/**
 * Example extension: start processes without `2>&1 | tail` decorations.
 *
 * Copy this file to ~/.pi/agent/extensions/tail-free-starts.ts. It requires
 * `@aliou/sh` (already present in ~/.pi/agent/npm/node_modules on setups that
 * have @aliou packages installed; otherwise run
 * `npm install @aliou/sh` in ~/.pi/agent/npm).
 *
 * Models love wrapping process starts in `command 2>&1 | tail -40`. That
 * destroys the stdout/stderr split, truncates the captured log, and hides
 * output from the process manager. This extension intercepts `process` start
 * calls and rewrites the command instead:
 *
 * - Output redirects (`2>&1`, `> /dev/null`, `2>/dev/null`, ...) are removed;
 *   stdin redirects (`<`, heredocs) and deliberate `1>&2` / `>&2` are kept.
 * - `tail` stages are removed with everything piped after them; the tail is
 *   remembered and applied later against the merged log.
 * - The start result gains the stdout, stderr, and merged log paths. The
 *   tail arrives with the exit notification, when the merged log is
 *   complete: the extension appends it (and the paths) to the process
 *   lifecycle message via `message_end`.
 * - Pipelines whose middle stages are filters (`cmd 2>&1 | grep error | head
 *   -15`) are left untouched: those stages read stderr through the merge,
 *   and the raw log cannot replay them.
 * - Commands that fail to parse are left untouched (fail safe).
 */
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { parse } from "@aliou/sh";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TailSpec {
  mode: "lines" | "bytes";
  count: number;
}

interface Range {
  start: number;
  end: number;
  replacement?: string;
}

interface Rewrite {
  command: string;
  tail: TailSpec | null;
  follow: boolean;
}

interface CollectContext {
  edits: Range[];
  tail: TailSpec | null;
  follow: boolean;
  source: string;
  /** Command nodes whose redirects must stay: pipelines keeping their
   *  middle stages (grep, head, ...) need `2>&1` to still see stderr. */
  keepRedirects: Set<object>;
}

/** Default snapshot length for a removed `tail -f` (the manager watches it). */
const FOLLOW_DEFAULT_LINES = 100;
function wordText(word: {
  parts: Array<Record<string, unknown>>;
}): string | null {
  let text = "";
  for (const part of word.parts) {
    if (part.type === "Text" && typeof part.text === "string")
      text += part.text;
    else return null; // expansions etc. — not a literal flag
  }
  return text;
}

function isTailStage(stage: { command: unknown }): boolean {
  const command = stage.command as
    | { type?: string; words?: unknown[] }
    | undefined;
  if (command?.type !== "SimpleCommand" || !Array.isArray(command.words))
    return false;
  return (
    wordText(command.words[0] as { parts: Array<Record<string, unknown>> }) ===
    "tail"
  );
}

/** Parse tail's flags. Returns null for anything ambiguous — fail safe. */
function parseTailArgs(
  args: string[],
): { tail: TailSpec; follow: boolean } | null {
  let tail: TailSpec | null = null;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      arg === "-f" ||
      arg === "--follow" ||
      arg === "-F" ||
      arg === "--follow=name"
    ) {
      follow = true;
      continue;
    }
    if (
      arg === "-n" ||
      arg === "--lines" ||
      arg === "-c" ||
      arg === "--bytes"
    ) {
      const value = args[++i];
      if (value === undefined) return null;
      const count = Number(value.replace(/^[+]/, ""));
      if (!Number.isInteger(count) || count < 0) return null;
      tail = {
        mode: arg === "-n" || arg === "--lines" ? "lines" : "bytes",
        count: count || 10,
      };
      continue;
    }
    if (/^-[nc]\d+$/.test(arg)) {
      const count = Number(arg.slice(3));
      if (!Number.isInteger(count) || count < 0) return null;
      tail = { mode: arg[1] === "n" ? "lines" : "bytes", count: count || 10 };
      continue;
    }
    if (/^-\d+$/.test(arg)) {
      const count = Number(arg.slice(1));
      if (!Number.isInteger(count) || count < 0) return null;
      tail = { mode: "lines", count: count || 10 };
      continue;
    }
    return null; // unknown flag or file operand — leave the command alone
  }
  return {
    tail: tail ?? { mode: "lines", count: follow ? FOLLOW_DEFAULT_LINES : 10 },
    follow,
  };
}

/**
 * Output redirects only: fd merges into stdout (`2>&1`, `>&1`, `>&`) and
 * file targets (`> file`, `2> file`, `>> file`). Deliberate stdout→stderr
 * writes (`1>&2`, `>&2`) are kept.
 */
function isOutputRedirect(redirect: {
  op: string;
  fd?: string;
  target: { parts: Array<Record<string, unknown>> };
}): boolean {
  if (redirect.op !== ">" && redirect.op !== ">>") return false;
  const first = redirect.target.parts[0] as
    | { type?: string; text?: string }
    | undefined;
  if (first?.type === "Text" && first.text === "2") return false; // x>&2: keep
  return true;
}

/**
 * Walk the AST collecting deletion ranges for output redirects and for
 * pipeline stages after the head when a `tail` stage is present.
 * Returns false when a tail's arguments cannot be parsed (leave command alone).
 */
function collectEdits(node: unknown, ctx: CollectContext): boolean {
  if (!node || typeof node !== "object") return true;
  const n = node as Record<string, unknown>;

  if (n.type === "Pipeline" && Array.isArray(n.commands)) {
    const stages = n.commands as Array<{
      command: Record<string, unknown>;
      pos?: { offset: number };
      end?: { offset: number };
    }>;
    const tailStage = stages.find(isTailStage as (s: unknown) => boolean);
    if (tailStage) {
      const tailWords = (
        (tailStage.command as { words?: unknown[] }).words ?? []
      ).map((w) => wordText(w as { parts: Array<Record<string, unknown>> }));
      const parsed = parseTailArgs(
        tailWords.slice(1).filter((w): w is string => w !== null),
      );
      if (!parsed) return false;
      ctx.tail = parsed.tail;
      ctx.follow = ctx.follow || parsed.follow;
      // Drop every stage after the head (pipes included): [headEnd, lastEnd).
      const headEnd = stages[0]?.end?.offset;
      const lastEnd = stages[stages.length - 1]?.end?.offset;
      if (headEnd !== undefined && lastEnd !== undefined && lastEnd > headEnd) {
        ctx.edits.push({ start: headEnd, end: lastEnd });
      }
    } else if (stages.length > 1) {
      // Filters (grep, head, sed, ...) stay and depend on the redirects
      // feeding them stderr; leave this pipeline untouched.
      const headCommand = stages[0]?.command;
      if (headCommand) ctx.keepRedirects.add(headCommand);
    }
  }

  // Redirects on any command node.
  if (Array.isArray(n.redirects) && !ctx.keepRedirects.has(n)) {
    for (const redirect of n.redirects as Array<{
      op: string;
      fd?: string;
      target: { parts: Array<Record<string, unknown>> };
      pos?: { offset: number };
      end?: { offset: number };
    }>) {
      if (isOutputRedirect(redirect) && redirect.pos && redirect.end) {
        ctx.edits.push({
          start: redirect.pos.offset,
          end: redirect.end.offset,
        });
      }
    }
  }

  // Quoted strings can hide a whole pipeline (ssh host "nix build ... 2>&1 | tail -40",
  // bash -c "..."). The parser treats them as opaque words, so clean the inner text
  // recursively and splice it back between the quotes.
  if (n.type === "SglQuoted" || n.type === "DblQuoted") {
    const pos = n.pos as { offset: number } | undefined;
    const end = n.end as { offset: number } | undefined;
    if (pos && end && end.offset - pos.offset >= 2) {
      const inner = ctx.source.slice(pos.offset + 1, end.offset - 1);
      if (inner.includes("tail") || inner.includes("2>&1")) {
        const nested = cleanCommand(inner);
        if (nested) {
          ctx.edits.push({
            start: pos.offset + 1,
            end: end.offset - 1,
            replacement: nested.command,
          });
          if (nested.tail) ctx.tail = nested.tail;
          ctx.follow = ctx.follow || nested.follow;
        }
      }
    }
    return true; // quoted content is opaque to the outer walk
  }

  // Recurse into child nodes (statements inside blocks, subshells, $(...), ...).
  for (const value of Object.values(n)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!child || typeof child !== "object") continue;
      if (!collectEdits(child, ctx)) return false;
    }
  }
  return true;
}

function applyEdits(source: string, edits: Range[]): string {
  let out = source;
  for (const { start, end, replacement } of [...edits].sort(
    (a, b) => b.start - a.start,
  )) {
    out = out.slice(0, start) + (replacement ?? "") + out.slice(end);
  }
  return out;
}

/** Clean a command; returns null when it should be left untouched. */
export function cleanCommand(command: string): Rewrite | null {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(command, { recoverErrors: true });
  } catch {
    return null;
  }
  if (!ast.ast || (ast.errors && ast.errors.length > 0)) return null;

  const ctx: CollectContext = {
    edits: [],
    tail: null,
    follow: false,
    source: command,
    keepRedirects: new Set(),
  };
  if (!collectEdits(ast.ast, ctx)) return null;
  if (ctx.edits.length === 0) return null;

  const cleaned = applyEdits(command, ctx.edits).replace(/ +/g, " ").trim();
  if (cleaned === command) return null;
  return { command: cleaned, tail: ctx.tail, follow: ctx.follow };
}

async function applyTail(file: string, tail: TailSpec): Promise<string> {
  const text = await readFile(file, "utf8");
  if (tail.mode === "bytes") {
    const sliced = text.slice(-tail.count);
    return sliced.length < text.length
      ? `[... earlier output truncated]\n${sliced}`
      : sliced;
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= tail.count) return lines.join("\n");
  return `[... ${lines.length - tail.count} earlier lines truncated]\n${lines.slice(-tail.count).join("\n")}`;
}

interface StartDetailsLike {
  process?: {
    id?: string;
    stdoutFile?: string;
    stderrFile?: string;
    status?: string;
    exitCode?: number | null;
  };
}

export default function (pi: ExtensionAPI) {
  // toolCallId → rewrite, until the start result comes back.
  const pendingStart = new Map<string, Rewrite>();
  // processId → rewrite + log paths, until the exit notification arrives.
  const pendingExit = new Map<
    string,
    { rewrite: Rewrite; stdoutFile: string; stderrFile: string }
  >();

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "process") return;
    if (event.input.action !== "start") return;
    const command = event.input.command;
    if (typeof command !== "string") return;
    const rewrite = cleanCommand(command);
    if (!rewrite) return;
    event.input.command = rewrite.command;
    pendingStart.set(event.toolCallId, rewrite);
  });

  const logPaths = (proc: {
    id: string;
    stdoutFile: string;
    stderrFile: string;
  }): string =>
    `Complete logs available at:\n- stdout: ${proc.stdoutFile}\n- stderr: ${proc.stderrFile}\n- merged: ${path.join(path.dirname(proc.stdoutFile), `${proc.id}-combined.log`)}`;

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "process") return;
    const rewrite = pendingStart.get(event.toolCallId);
    if (!rewrite) return;
    pendingStart.delete(event.toolCallId);
    if (event.isError) return;

    const details = event.structuredContent as StartDetailsLike | undefined;
    const proc = details?.process;
    if (!proc?.id || !proc.stdoutFile || !proc.stderrFile) return;

    const parts: string[] = [];
    if (rewrite.follow) {
      parts.push(
        "Removed `tail -f` from the command: the process manager already captures the full stream and watches it.",
      );
    }
    if (proc.status === "running") {
      // Output is not written yet; the tail is appended when the exit
      // notification arrives (see message_end below).
      parts.push("Tail of the output will be appended when the process exits.");
      pendingExit.set(proc.id, {
        rewrite,
        stdoutFile: proc.stdoutFile,
        stderrFile: proc.stderrFile,
      });
    } else {
      try {
        const combinedFile = path.join(
          path.dirname(proc.stdoutFile),
          `${proc.id}-combined.log`,
        );
        const tailText = await applyTail(
          combinedFile,
          rewrite.tail ?? { mode: "lines", count: 10 },
        );
        parts.push(
          `Output of the merged stream (exit code: ${proc.exitCode ?? "?"}):\n${tailText}`,
        );
      } catch (error) {
        parts.push(
          `Could not read merged log: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    parts.push(
      logPaths({
        id: proc.id,
        stdoutFile: proc.stdoutFile,
        stderrFile: proc.stderrFile,
      }),
    );

    const original = event.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");
    return {
      content: [{ type: "text", text: `${original}\n\n${parts.join("\n\n")}` }],
    };
  });

  // pi-processes reports exits as custom messages; append the tail there,
  // when the merged log is actually complete.
  pi.on("message_end", async (event) => {
    const message = event.message as
      | {
          customType?: string;
          content?: unknown;
          details?: { kind?: string; processId?: string };
        }
      | undefined;
    if (message?.customType !== "ad-process:notification") return;
    const details = message.details as
      | { kind?: string; processId?: string; exitCode?: number | null }
      | undefined;
    if (!details?.processId) return;
    if (
      details.kind !== "success" &&
      details.kind !== "failure" &&
      details.kind !== "crash" &&
      details.kind !== "killed"
    ) {
      return;
    }
    const entry = pendingExit.get(details.processId);
    if (!entry) return;
    const rewrite = entry.rewrite;
    pendingExit.delete(details.processId);

    const combinedFile = path.join(
      path.dirname(entry.stdoutFile),
      `${details.processId}-combined.log`,
    );

    let tailSection: string;
    try {
      const tailText = await applyTail(
        combinedFile,
        rewrite.tail ?? { mode: "lines", count: 10 },
      );
      tailSection = `Output of the merged stream (exit: ${details.kind}${details.exitCode !== undefined ? `, code ${details.exitCode}` : ""}):\n${tailText}`;
    } catch (error) {
      tailSection = `Could not read merged log: ${error instanceof Error ? error.message : String(error)}`;
    }
    const stdoutFile = entry.stdoutFile;
    const stderrFile = entry.stderrFile;
    const updated = {
      ...event.message,
      content: `${String(message.content)}\n\n${tailSection}\n\n${logPaths({ id: details.processId, stdoutFile, stderrFile })}`,
    } as typeof event.message;
    return { message: updated };
  });

  pi.on("session_start", async () => {
    pendingStart.clear();
    pendingExit.clear();
  });
}
