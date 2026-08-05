import {
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Tier = "lite" | "full" | "ultra";
type StoredTier = Tier | "normal";
type State = { enabled: true; tier: Tier } | { enabled: false };
type JsonObject = Record<string, unknown>;

const SETTINGS_KEY = "pohuy";
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const TIERS = ["lite", "full", "ultra"] as const;
const USAGE = "Use /pohuy, /pohuy lite, /pohuy full, /pohuy ultra, or /pohuy normal.";
const PROMPT_SENTINEL = "<!-- pohuy:complete-style-bundle -->";
const SKILL_ROOT = new URL("../skills/pohuy/", import.meta.url);
const REFERENCE_FILES = [
  "references/slovar.md",
  "references/sceny.md",
  "references/ontologia.md",
] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function stateFor(tier: StoredTier): State {
  return tier === "normal" ? { enabled: false } : { enabled: true, tier };
}

function prepareSkillForEmbedding(skill: string): string {
  const withoutFrontmatter = skill.replace(/^---\n[\s\S]*?\n---\n/, "");
  return withoutFrontmatter.replace(
    /\n## Активация\n[\s\S]*?(?=\n## Persistence\n)/,
    "\n",
  ).trim();
}

async function loadCompleteStyleBundle(): Promise<string> {
  const [skill, ...references] = await Promise.all([
    readFile(new URL("SKILL.md", SKILL_ROOT), "utf8"),
    ...REFERENCE_FILES.map((path) => readFile(new URL(path, SKILL_ROOT), "utf8")),
  ]);

  return [
    prepareSkillForEmbedding(skill),
    ...references.map((content, index) =>
      `## Embedded reference: ${REFERENCE_FILES[index]}\n\n${content.trim()}`
    ),
  ].join("\n\n---\n\n");
}

function appendStylePrompt(basePrompt: string, stylePrompt: string): string {
  if (basePrompt.includes(PROMPT_SENTINEL)) return basePrompt;
  return `${basePrompt.replace(/\n+$/, "")}\n\n${PROMPT_SENTINEL}\n${stylePrompt}\n`;
}

async function readStoredTier(): Promise<StoredTier> {
  try {
    const settings: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    if (!isJsonObject(settings) || !isJsonObject(settings[SETTINGS_KEY])) return "normal";

    const tier = settings[SETTINGS_KEY].tier;
    return tier === "normal" || isTier(tier) ? tier : "normal";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "normal";
    throw error;
  }
}

async function saveStoredTier(tier: StoredTier): Promise<void> {
  await withFileMutationQueue(SETTINGS_PATH, async () => {
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });

    let settings: JsonObject = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
      if (!isJsonObject(parsed)) throw new Error(`${SETTINGS_PATH} must contain a JSON object`);
      settings = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporary = `${SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const mode = await stat(SETTINGS_PATH)
        .then((info) => info.mode & 0o777)
        .catch(() => 0o600);
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(`${JSON.stringify({
          ...settings,
          [SETTINGS_KEY]: { tier },
        }, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, SETTINGS_PATH);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export default async function pohuyExtension(pi: ExtensionAPI) {
  const styleBundle = await loadCompleteStyleBundle();
  let state: State = stateFor(await readStoredTier());

  pi.on("session_start", async () => {
    state = stateFor(await readStoredTier());
  });

  pi.registerCommand("pohuy", {
    description: "Set Pohuy response style: /pohuy [lite|full|ultra|normal]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const options = [...TIERS, "normal"];
      const value = prefix.trim().toLowerCase();
      const items = options
        .filter((option) => option.startsWith(value))
        .map((option) => ({ value: option, label: option }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length > 1) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
        return;
      }

      const value = tokens[0] ?? "full";
      let tier: StoredTier;
      if (value === "normal") {
        tier = value;
      } else if (isTier(value)) {
        tier = value;
      } else {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
        return;
      }

      try {
        await saveStoredTier(tier);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Could not save Pohuy settings: ${String(error)}`, "error");
        return;
      }

      state = stateFor(tier);
      if (ctx.hasUI) {
        ctx.ui.notify(
          tier === "normal" ? "Pohuy disabled. Normal mode restored." : `Pohuy enabled: ${tier}.`,
          "info",
        );
      }
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!state.enabled) return;

    const stylePrompt = [
      "Active session style: pohuy. Apply the embedded policy to natural-language assistant responses only.",
      "The complete skill and all references are embedded below and already loaded. Do not call tools to read, update, or compare the Pohuy skill or its references.",
      "Do not alter tool calls, tool results, code, commands, identifiers, error strings, structured output, commits, pull requests, documentation, or higher-priority instructions.",
      styleBundle,
      `Selected tier for this session: ${state.tier}. Keep this tier until /pohuy changes it or /pohuy normal disables the style.`,
    ].join("\n\n");

    return {
      systemPrompt: appendStylePrompt(event.systemPrompt, stylePrompt),
    };
  });
}
