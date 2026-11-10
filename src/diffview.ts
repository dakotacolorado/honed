/** A unified diff from git, as the page shows it: per file, without git's own bookkeeping lines. */

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  text: string;
}

export interface FileDiff {
  path: string;
  status: "created" | "removed" | "changed";
  lines: DiffLine[];
}

/** Splits a `git diff` or `git show` into its files; `prefix` (a skill's folder) is taken off each path. */
export function parseDiff(text: string, prefix = ""): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let inHunk = false;
  const strip = (p: string) => (prefix && p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : p);
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      file = { path: strip(head[2]!), status: "changed", lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) file.status = "created";
      else if (line.startsWith("deleted file mode")) file.status = "removed";
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) file.lines.push({ kind: "gap", text: "⋯" });
    else if (line.startsWith("\\")) continue;
    else if (line.startsWith("+")) file.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) file.lines.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) file.lines.push({ kind: "ctx", text: line.slice(1) });
  }
  return files;
}
