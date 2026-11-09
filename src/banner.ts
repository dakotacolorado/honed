import { homedir } from "node:os";

export const WORDMARK = [
  " _                        _",
  "| |__   ___  _ __   ___  __| |",
  "| '_ \\ / _ \\| '_ \\ / _ \\/ _` |",
  "| | | | (_) | | | |  __/ (_| |",
  "|_| |_|\\___/|_| |_|\\___|\\__,_|",
].join("\n");

export const TAGLINE = "Skills your agents sharpen every time they use them.";

/** Colors only for a terminal that wants them (https://no-color.org). */
export function palette(enabled: boolean) {
  const paint = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { ember: paint("38;5;173"), bold: paint("1"), dim: paint("2"), green: paint("38;5;108") };
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

export interface BannerInfo {
  version: string;
  url: string;
  dir: string;
  tokens: number;
  judge: boolean;
  color: boolean;
}

/** What honed says when it starts: what it is, where it is, the one command to connect, and how it works. */
export function banner(b: BannerInfo): string {
  const c = palette(b.color);
  const mcp = `${b.url}/mcp`;
  const header = b.tokens ? ' --header "Authorization: Bearer <token>"' : "";
  return [
    "",
    c.ember(WORDMARK),
    `${c.dim("══════════════════════════════")}${c.ember("✦")}  ${c.dim(`v${b.version}`)}`,
    "",
    c.bold(TAGLINE),
    "",
    `  ${c.ember("✦")} Library   ${b.url}`,
    `  ${c.ember("✦")} MCP       ${mcp}`,
    `  ${c.ember("✦")} Stored    ${tilde(b.dir)}`,
    "",
    c.bold("Connect Claude Code (once):"),
    `  claude mcp add --transport http --scope user honed ${mcp}${header}`,
    "",
    c.bold("How it works"),
    `  Before a task, agents ${c.ember("search_skills")} and ${c.ember("get_skill")}. After, they ${c.ember("submit_feedback")}:`,
    "  what happened and what should change. Each skill is revised from that",
    "  feedback, and every version is kept with why it changed.",
    "",
    `  ${c.dim(b.tokens ? `${b.tokens} token${b.tokens === 1 ? "" : "s"}: every request needs one.` : "Local only: no tokens, answering this machine.")}${b.judge ? "" : c.dim(" Revision is off (--no-judge).")}`,
    `  ${c.dim("Ctrl+C to stop.")}`,
    "",
  ].join("\n");
}
