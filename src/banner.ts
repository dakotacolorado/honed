import { homedir } from "node:os";

const LETTERS = [
  "██╗  ██╗ ██████╗ ███╗   ██╗███████╗██████╗",
  "██║  ██║██╔═══██╗████╗  ██║██╔════╝██╔══██╗",
  "███████║██║   ██║██╔██╗ ██║█████╗  ██║  ██║",
  "██╔══██║██║   ██║██║╚██╗██║██╔══╝  ██║  ██║",
  "██║  ██║╚██████╔╝██║ ╚████║███████╗██████╔╝",
  "╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚═════╝",
];

/** A pixel sword, point up and to the right: blade, crossguard, grip and pommel, on a 12 by 12 grid, its point symmetric on both edges. */
export const SWORD_PIXELS = [
  "..........##",
  ".........###",
  "........###.",
  ".......###..",
  "......###...",
  "..#..###....",
  "...####.....",
  "...###......",
  "..##.##.....",
  ".##...#.....",
  "##..........",
  "#...........",
];

/** The sword as text, two pixels a character, for terminals; the page draws SWORD_PIXELS as an image instead. */
const SWORD = Array.from({ length: SWORD_PIXELS.length / 2 }, (_, row) =>
  [...SWORD_PIXELS[row * 2]!]
    .map((top, col) => {
      const t = top === "#", b = SWORD_PIXELS[row * 2 + 1]![col] === "#";
      return t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    })
    .join("")
    .trimEnd(),
);

/** The letters alone, for the page, which sets the sword beside them as an image. */
export const LETTERS_ONLY = LETTERS.join("\n");

export const WORDMARK = LETTERS.map((line, i) => `${line.padEnd(43)}  ${SWORD[i]}`.trimEnd()).join("\n");


export const TAGLINE = "Skills your agents sharpen every time they use them.";
/** What honed is and how it works, in one line. */
export const SUMMARY = "Share and hone skills across your organization: agents use a skill, say how it went, and honed revises it.";

/** Colors only for a terminal that wants them (https://no-color.org). */
export function palette(enabled: boolean) {
  const paint = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { edge: paint("38;5;37"), bold: paint("1"), dim: paint("2"), green: paint("38;5;108") };
}

/** Where the plugin looks for honed unless told otherwise. */
export const DEFAULT_URL = "http://127.0.0.1:4321";

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

export interface BannerInfo {
  version: string;
  url: string;
  dir: string;
  tokens: number;
  /** Who revises skills, or why nothing does. */
  reviser: string;
  color: boolean;
}

/** What honed says when it starts: what it is, where it is, the one command to connect, and how it works. */
export function banner(b: BannerInfo): string {
  const c = palette(b.color);
  return [
    "",
    c.edge(WORDMARK),
    c.dim(`🗡 v${b.version}`),
    "",
    c.bold(TAGLINE),
    SUMMARY,
    "",
    `  ${c.edge("▸")} Library   ${b.url}`,
    `  ${c.edge("▸")} API       ${b.url}/api/skills   docs ${b.url}/docs/api`,
    `  ${c.edge("▸")} MCP       ${b.url}/mcp          docs ${b.url}/docs/mcp`,
    `  ${c.edge("▸")} Stored    ${tilde(b.dir)}`,
    "",
    c.bold("Connect Claude Code (once), with the honed plugin:"),
    `  claude plugin marketplace add dakotacolorado/honed`,
    `  claude plugin install honed@honed${b.url === DEFAULT_URL ? "" : ` --config url=${b.url}`}`,
    ...(b.tokens ? [`  then /plugin configure honed@honed in a session, to give it your token`] : []),
    "",

    `  ${c.dim(b.reviser)}`,
    `  ${c.dim(b.tokens ? `${b.tokens} token${b.tokens === 1 ? "" : "s"}: every request needs one.` : "Local only: no tokens, answering this machine.")}`,
    `  ${c.dim("Ctrl+C to stop.")}`,
    "",
  ].join("\n");
}
