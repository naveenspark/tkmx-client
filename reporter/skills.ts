import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_MANIFEST = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const DEFAULT_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");

interface PluginManifest {
  plugins?: Record<string, unknown>;
}

// Personal skills live outside the plugin system: one directory per skill, each
// holding a SKILL.md. The marker file is what separates a skill from a stray
// directory, so a folder without one is not reported.
function collectPersonalSkills(skillsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    // Skills are often symlinked in from a shared repo rather than copied, and
    // Dirent.isDirectory() reports false for a symlink. statSync follows the
    // link — and throws on a dangling one, which we simply skip.
    const entryPath = path.join(skillsDir, entry.name);
    try {
      if (!fs.statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (fs.existsSync(path.join(entryPath, "SKILL.md"))) names.push(entry.name);
  }
  return names;
}

// Authoritative plugin list lives in installed_plugins.json — walking the
// cache directly would pick up temp_git_* clones and their repo contents.
export function collectClaudeSkills(
  manifestPath: string = DEFAULT_MANIFEST,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): string[] {
  // Report one entry per installed plugin (e.g. "superpowers"), not one per
  // skill inside it — the plugin is the unit users recognize and share.
  // Sorted output keeps the machine-config hash stable across runs.
  const skills = new Set<string>();

  let parsed: PluginManifest | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as PluginManifest;
  } catch {
    // A missing or malformed manifest is not fatal: personal skills below are an
    // independent source and should still be reported.
    parsed = null;
  }

  for (const pluginKey of Object.keys(parsed?.plugins || {})) {
    // pluginKey looks like "superpowers@claude-plugins-official"
    skills.add(pluginKey.split("@")[0]);
  }

  for (const name of collectPersonalSkills(skillsDir)) skills.add(name);

  return Array.from(skills).sort();
}

// Drops names the user does not want published, applied last so it catches an
// entry no matter which source produced it. Comparison is case-insensitive
// because the same skill is spelled inconsistently across sources.
export function applyExclusions(names: string[], rawExcludeList: string | undefined): string[] {
  const excluded = new Set(
    (rawExcludeList || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
  if (excluded.size === 0) return names;
  return names.filter((name) => !excluded.has(name.trim().toLowerCase()));
}
