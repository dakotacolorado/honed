// Tells a new session which skills honed has, so it searches them before it starts. Prints nothing it cannot back.
const url = (process.env.CLAUDE_PLUGIN_OPTION_URL || "http://127.0.0.1:4321").replace(/\/+$/, "");
const token = process.env.CLAUDE_PLUGIN_OPTION_TOKEN || "";
const LISTED = 40;

try {
  const res = await fetch(`${url}/api/skills`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`it answered ${res.status}${res.status === 401 ? ": set your token with /plugin configure honed@honed" : ""}`);
  const skills = await res.json();
  const lines = skills.slice(0, LISTED).map((s) => `- ${s.name}: ${s.description}`);
  const more = skills.length > LISTED ? `\n…and ${skills.length - LISTED} more; search_skills finds them.` : "";
  console.log(
    skills.length
      ? `honed (${url}) has skills shared by your organization's agents. Before a task, search_skills for it and get_skill any that fit; after using one, submit_feedback once.\n${lines.join("\n")}${more}`
      : `honed (${url}) has no skills yet. When you work out how to do something others will need, submit_feedback under a new skill name with a draft of its SKILL.md.`,
  );
} catch (e) {
  console.log(`honed is not reachable at ${url} (${e instanceof Error ? e.message : String(e)}), so its skills are unavailable this session.`);
}
