// Before a session stops, asks for feedback on each honed skill it read and has not rated. Asks once: a session
// already continuing because of a stop hook is let go, so it can never loop.
import { readFileSync } from "node:fs";

const TOOL = /^mcp__.*honed.*__(read_skill|give_feedback)$/;

/** The skills a transcript read with read_skill and has not given feedback on, in the order first read. */
export function unrated(transcript) {
  const read = [];
  const rated = new Set();
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      const tool = TOOL.exec(block.name)?.[1];
      const name = block.input?.name;
      if (!tool || typeof name !== "string") continue;
      if (tool === "read_skill" && !read.includes(name)) read.push(name);
      if (tool === "give_feedback") rated.add(name);
    }
  }
  return read.filter((name) => !rated.has(name));
}

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (!input.stop_hook_active && input.transcript_path) {
  let transcript = "";
  try {
    transcript = readFileSync(input.transcript_path, "utf8");
  } catch {}
  const skills = unrated(transcript);
  if (skills.length) {
    console.log(
      JSON.stringify({
        decision: "block",
        reason: `You read the honed skill${skills.length > 1 ? "s" : ""} ${skills.join(", ")} this session and gave no feedback. For each one you actually used, call give_feedback once (helped, hurt or missing) with what happened; that is how skills improve. Skip any you read but did not use, then finish.`,
      }),
    );
  }
}
