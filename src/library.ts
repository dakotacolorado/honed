import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Refusal, type SkillFile } from "./domain.ts";

const run = promisify(execFile);

/**
 * The skills' files, as a git repository with one folder per skill. Every version is a commit,
 * so the files at any version, and the change each version made, are git's to answer.
 */
export class Library {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await run("git", ["-C", this.root, ...args], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string };
      throw new Error(`git ${args[0]} failed: ${err.stderr?.trim() || String(e)}`);
    }
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const exists = await access(join(this.root, ".git")).then(() => true, () => false);
    if (exists) return;
    await this.git(["init", "-q", "-b", "main"]);
    await this.git(["config", "user.name", "honed"]);
    await this.git(["config", "user.email", "honed@localhost"]);
    await this.git(["commit", "-q", "--allow-empty", "-m", "The library, empty"]);
  }

  /** A skill's files as they were at `commit`. */
  async files(name: string, commit: string): Promise<SkillFile[]> {
    const listing = await this.git(["ls-tree", "-r", "-z", commit, "--", `${name}/`]);
    const entries = listing
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t") as [string, string];
        return { mode: meta.split(" ")[0], path };
      });
    return Promise.all(
      entries.map(async (e) => ({
        path: e.path.slice(name.length + 1),
        content: await this.git(["show", `${commit}:${e.path}`]),
        executable: e.mode === "100755",
      })),
    );
  }

  /** Makes `files` the whole of the skill and commits it; the commit's id. Refused if it changes nothing. */
  async commit(name: string, files: SkillFile[], message: string): Promise<string> {
    const dir = join(this.root, name);
    await rm(dir, { recursive: true, force: true });
    for (const f of files) {
      const path = join(dir, f.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, f.content);
      await chmod(path, f.executable ? 0o755 : 0o644);
    }
    await this.git(["add", "-A", "--", `${name}/`]);
    const changed = await run("git", ["-C", this.root, "diff", "--cached", "--quiet", "--", `${name}/`]).then(
      () => false,
      () => true,
    );
    if (!changed) throw new Refusal("the change leaves the skill as it is", 409);
    await this.git(["commit", "-q", "-m", message, "--", `${name}/`]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  /** Removes the skill's folder and commits it; its history stays in the repo. */
  async remove(name: string, message: string): Promise<string> {
    await rm(join(this.root, name), { recursive: true, force: true });
    await this.git(["add", "-A", "--", `${name}/`]);
    await this.git(["commit", "-q", "--allow-empty", "-m", message, "--", `${name}/`]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  /** What `commit` changed in the skill, as a unified diff. */
  async diff(name: string, commit: string): Promise<string> {
    return this.git(["show", "--format=", "--no-color", commit, "--", `${name}/`]);
  }

  /** The unified diff from one set of a skill's files to another. */
  async compare(before: SkillFile[], after: SkillFile[]): Promise<string> {
    const tmp = await mkdtemp(join(tmpdir(), "honed-"));
    try {
      for (const [side, files] of [["a", before], ["b", after]] as const) {
        await mkdir(join(tmp, side), { recursive: true });
        for (const f of files) {
          const path = join(tmp, side, f.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, f.content);
          await chmod(path, f.executable ? 0o755 : 0o644);
        }
      }
      const { stdout } = await run("git", ["diff", "--no-index", "--no-color", "a", "b"], { cwd: tmp, encoding: "utf8" }).catch(
        (e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }),
      );
      // The two sides are folders a/ and b/ here, so git names files a/a/x and b/b/x; name them as a skill's own diff does.
      return stdout
        .split("\n")
        .map((line) => (/^(diff --git |--- |\+\+\+ )/.test(line) ? line.replace(/(^|\s|^diff --git )([ab])\/[ab]\//g, "$1$2/") : line))
        .join("\n");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** The folder a skill's current files are checked out in, for running its scripts. */
  path(name: string): string {
    return join(this.root, name);
  }
}
