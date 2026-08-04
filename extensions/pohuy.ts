import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";

type Tier = "lite" | "full" | "ultra";
type State = { enabled: true; tier: Tier } | { enabled: false };

const STATE_TYPE = "pohuy-state";
const TIERS = ["lite", "full", "ultra"] as const;
const USAGE = "Use /pohuy, /pohuy lite, /pohuy full, /pohuy ultra, or /pohuy normal.";

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

export default async function pohuyExtension(pi: ExtensionAPI) {
  const skill = await readFile(
    new URL("../skills/pohuy/SKILL.md", import.meta.url),
    "utf8",
  );
  let state: State = { enabled: false };

  pi.on("session_start", (_event, ctx) => {
    state = { enabled: false };

    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;

      const data = entry.data as { enabled?: unknown; tier?: unknown };
      state = data.enabled === true && typeof data.tier === "string" && isTier(data.tier)
        ? { enabled: true, tier: data.tier }
        : { enabled: false };
      break;
    }
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
      if (value === "normal") {
        state = { enabled: false };
        pi.appendEntry(STATE_TYPE, state);
        if (ctx.hasUI) ctx.ui.notify("Pohuy disabled. Normal mode restored.", "info");
        return;
      }

      if (!isTier(value)) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
        return;
      }

      state = { enabled: true, tier: value };
      pi.appendEntry(STATE_TYPE, state);
      if (ctx.hasUI) ctx.ui.notify(`Pohuy enabled: ${value}.`, "info");
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!state.enabled) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n` +
        "Active session style: pohuy. Apply the following skill to natural-language assistant responses only. " +
        "Do not alter tool calls, tool results, code, commands, identifiers, error strings, structured output, " +
        "commits, pull requests, documentation, or higher-priority instructions.\n\n" +
        `${skill}\n\nSelected tier for this session: ${state.tier}. ` +
        "Keep this tier until /pohuy changes it or /pohuy normal disables the style.",
    };
  });
}
