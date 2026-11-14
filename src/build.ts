import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Build {
  /** The commit this copy was built from, `-dirty` when its tree differed; "unknown" when there was no git to ask. */
  commit: string;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A checkout's commit, `-dirty` when its tree differs from it; "unknown" outside a checkout. */
export function gitBuild(cwd: string = ROOT): Build {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const dirty = git("status", "--porcelain").length > 0;
    return { commit: git("rev-parse", "HEAD") + (dirty ? "-dirty" : "") };
  } catch {
    return { commit: "unknown" };
  }
}

/**
 * The commit this copy was built from: `build.json`, written by `npm run
 * build` beside the compiled code, since a package installed from npm has no
 * git to ask; else the checkout it runs in; else "unknown".
 */
export function buildOf(): Build {
  const stamped = new URL("./build.json", import.meta.url);
  if (existsSync(stamped)) {
    try {
      const { commit } = JSON.parse(readFileSync(stamped, "utf8")) as Partial<Build>;
      return { commit: typeof commit === "string" && commit ? commit : "unknown" };
    } catch {
      return { commit: "unknown" };
    }
  }
  return gitBuild();
}

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error("usage: node src/build.ts <file>");
  writeFileSync(file, `${JSON.stringify(gitBuild())}\n`);
}
