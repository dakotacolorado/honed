// Before a session stops, asks whether each honed skill it got and gave no feedback on fell short. Asks once: a session
// already continuing because of a stop hook is let go, so it can never loop.
import { readFileSync } from "node:fs";

const TOOL = /^mcp__.*honed.*__(get_skill|submit_feedback)$/;

/** The skills a transcript got with get_skill and gave no feedback on, in the order first got. */
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
      if (tool === "get_skill" && !read.includes(name)) read.push(name);
      if (tool === "submit_feedback") rated.add(name);
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
        reason: `You got the honed skill${skills.length > 1 ? "s" : ""} ${skills.join(", ")} this session and gave no feedback. For each one you followed, call submit_feedback only if it fell short: it was wrong, it left out something you had to find out, or the person or a check corrected you on what it covers. Say what happened and what it should say. If it simply worked, or what you would add is something any capable agent does anyway, send nothing. Then finish.`,
      }),
    );
  }
}
