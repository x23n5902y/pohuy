import {
  formatSkillsForPrompt,
  getAgentDir,
  withFileMutationQueue,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

type Tier = "lite" | "full" | "ultra";
type StoredTier = Tier | "normal";
type BasePromptMode = "default" | "minimal";
type JsonObject = Record<string, unknown>;

const SETTINGS_KEY = "pohuy";
const SETTINGS_PATH = join(getAgentDir(), "settings.json");
const TIERS = ["lite", "full", "ultra"] as const;
const USAGE = "Use /pohuy, /pohuy lite, /pohuy full, /pohuy ultra, or /pohuy normal.";
const PROMPT_START = "<!-- POHUY:START -->";
const PROMPT_END = "<!-- POHUY:END -->";
const ENABLE_PHRASES = new Set(["та мне похуй", "заебал"]);
const DISABLE_PHRASES = new Set(["нормальный режим", "хватит материться"]);
const SKILL_PATH = new URL("../skills/pohuy/SKILL.md", import.meta.url);
const SLOVAR_PATH = new URL("../skills/pohuy/references/slovar.md", import.meta.url);
const SCENES_PATH = new URL("../skills/pohuy/references/sceny.md", import.meta.url);
const CORE_SKILL_SECTIONS = [
  "Persistence",
  "Правила",
  "Шкала состояний проекта",
  "Auto-Clarity (мат выключается)",
  "Boundaries",
] as const;
const OPTIONAL_SKILL_SECTIONS = [
  "Словарь (рабочий минимум)",
] as const;
const SCENE_FRAMING =
  "Scene examples are tone references, not scripts. Never quote them verbatim; adapt them to the current situation.";
const MINIMAL_BASE_PROMPT = `You are a capable general-purpose agent.

Follow higher-priority and project-local instructions. Use available tools when they improve correctness, inspect relevant sources before making claims, and verify completed work when practical.

Be precise, direct, and useful. Preserve technical identifiers, commands, error messages, and required output formats exactly. Ask for clarification only when the task cannot be completed safely from the available information.

Treat the supplied tools, guidelines, context files, skills, and appended instructions as authoritative. Keep tool calls, structured output, code, and other machine-consumed content valid and separate from conversational prose.`;
const DEFAULT_ULTRA_SCENES = [
  "Легаси-археология",
  "Каскадный отказ",
  "Триумф после долгого дебага",
] as const;
const FEATURE_STATE_VALUES = ["enabled", "disabled", "selected"] as const;
const SOURCE_PRESET_VALUES = ["tier-defaults", "custom"] as const;
const SETTINGS_SECTIONS = ["general", "skill", "dictionary", "scenes"] as const;
const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  general: "General",
  skill: "Skill",
  dictionary: "Dictionary",
  scenes: "Scenes",
};
const NON_OPTIONAL_DICTIONARY_PREFIXES = ["Чего в словаре нет"] as const;
const DICTIONARY_DESCRIPTIONS: Record<string, string> = {
  "Состояния и статусы": "Лексика для оценки состояния проекта: от нормальной работы до полного отказа.",
  "Действия": "Глаголы и выражения для работы, ошибок, исправлений, ожидания и бесполезной возни.",
  "Оценки и количества": "Оценки масштаба, количества, уверенности и значимости.",
  "Сущности": "Названия для кода, артефактов, процессов и прочих технических сущностей.",
};

type FeatureState = (typeof FEATURE_STATE_VALUES)[number];
type SourcePreset = (typeof SOURCE_PRESET_VALUES)[number];
type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
type StoredSettings = {
  tier: StoredTier;
  basePrompt: BasePromptMode;
  selectedSections?: string[];
};
type SettingsItem = {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values: string[];
};
type SourceOption = {
  id: string;
  section: Exclude<SettingsSection, "general">;
  label: string;
  description: string;
  content: string;
};
type StyleSource = {
  common: string[];
  tiers: Record<Tier, string>;
  options: SourceOption[];
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function extractHeadingSection(markdown: string, depth: number, heading: string, source: string): string {
  const lines = markdown.split("\n");
  const marker = `${"#".repeat(depth)} ${heading}`;
  const start = lines.findIndex((line) => line.trimEnd() === marker);
  if (start === -1) throw new Error(`Missing ${source} section: ${heading}`);

  const next = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const match = line.match(/^(#{1,6})\s/);
    return match !== null && match[1].length <= depth;
  });
  const body = lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim();
  if (!body) throw new Error(`Empty ${source} section: ${heading}`);
  return `${marker}\n\n${body}`;
}

function extractSkillSection(markdown: string, heading: string): string {
  return extractHeadingSection(markdown, 2, heading, "SKILL.md");
}

function headingsAtDepth(markdown: string, depth: number): string[] {
  const prefix = `${"#".repeat(depth)} `;
  return markdown
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}#`))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean);
}

function requiredHeadingWithPrefix(markdown: string, depth: number, prefix: string): string {
  const heading = headingsAtDepth(markdown, depth).find((candidate) => candidate.startsWith(prefix));
  if (!heading) throw new Error(`Missing heading beginning with: ${prefix}`);
  return heading;
}

function sourceId(source: "skill" | "slovar" | "sceny", heading: string): string {
  return `${source}:${heading}`;
}

function plainMarkdownText(text: string): string {
  return text
    .replace(/^>\s?/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function firstContentBlock(content: string): string {
  const lines = content.split("\n").slice(1);
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start === -1) return "";
  const endOffset = lines.slice(start).findIndex((line) => line.trim() === "");
  const end = endOffset === -1 ? lines.length : start + endOffset;
  return plainMarkdownText(lines.slice(start, end).join("\n"));
}

function sourceOption(
  source: "skill" | "slovar" | "sceny",
  heading: string,
  content: string,
): SourceOption {
  return {
    id: sourceId(source, heading),
    section: source === "skill" ? "skill" : source === "slovar" ? "dictionary" : "scenes",
    label: heading,
    description: source === "slovar"
      ? DICTIONARY_DESCRIPTIONS[heading] ?? firstContentBlock(content)
      : firstContentBlock(content),
    content,
  };
}

function extractTierPolicy(levels: string, tier: Tier): string {
  const lines = levels.split("\n");
  const tableRow = lines.find((line) => line.startsWith(`| **${tier}** |`));
  if (!tableRow) throw new Error(`Missing SKILL.md tier table row: ${tier}`);

  const examples: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith(`- ${tier}:`)) continue;
    const block = [lines[index]];
    while (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1])) {
      block.push(lines[index + 1]);
      index += 1;
    }
    examples.push(block.join("\n"));
  }
  if (examples.length === 0) throw new Error(`Missing SKILL.md tier examples: ${tier}`);

  return [`## Уровень ${tier}`, tableRow, ...examples].join("\n\n");
}

async function loadStyleSource(): Promise<StyleSource> {
  const [skill, slovar, scenes] = await Promise.all([
    readFile(SKILL_PATH, "utf8"),
    readFile(SLOVAR_PATH, "utf8"),
    readFile(SCENES_PATH, "utf8"),
  ]);
  const levels = extractSkillSection(skill, "Уровни");
  const nonOptionalDictionaryHeading = requiredHeadingWithPrefix(
    slovar,
    2,
    NON_OPTIONAL_DICTIONARY_PREFIXES[0],
  );
  const common = [
    ...CORE_SKILL_SECTIONS.map((heading) => extractSkillSection(skill, heading)),
    extractHeadingSection(slovar, 2, nonOptionalDictionaryHeading, "slovar.md"),
    SCENE_FRAMING,
  ];
  const options = [
    ...OPTIONAL_SKILL_SECTIONS.map((heading) =>
      sourceOption("skill", heading, extractSkillSection(skill, heading))
    ),
    ...headingsAtDepth(slovar, 2)
      .filter((heading) =>
        !NON_OPTIONAL_DICTIONARY_PREFIXES.some((prefix) => heading.startsWith(prefix))
      )
      .map((heading) =>
        sourceOption("slovar", heading, extractHeadingSection(slovar, 2, heading, "slovar.md"))
      ),
    ...headingsAtDepth(scenes, 3).map((heading) =>
      sourceOption("sceny", heading, extractHeadingSection(scenes, 3, heading, "sceny.md"))
    ),
  ];

  const source: StyleSource = {
    common,
    options,
    tiers: Object.fromEntries(
      TIERS.map((tier) => [tier, extractTierPolicy(levels, tier)]),
    ) as Record<Tier, string>,
  };
  assertDefaultSections(source);
  return source;
}

function defaultSectionIds(tier: StoredTier): string[] {
  if (tier === "lite" || tier === "normal") return [];
  const full = OPTIONAL_SKILL_SECTIONS.map((heading) => sourceId("skill", heading));
  if (tier === "full") return full;
  return [
    ...full,
    sourceId("slovar", "Образность: восклицания, звукопись, присказки"),
    ...DEFAULT_ULTRA_SCENES.map((heading) => sourceId("sceny", heading)),
  ];
}

function assertDefaultSections(source: StyleSource): void {
  const known = new Set(source.options.map((option) => option.id));
  const required = new Set([
    ...defaultSectionIds("full"),
    ...defaultSectionIds("ultra"),
  ]);
  const missing = [...required].filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`Missing default policy sections: ${missing.join(", ")}`);
}

function selectedSectionIds(settings: StoredSettings, source: StyleSource): string[] {
  const selected = new Set(settings.selectedSections ?? defaultSectionIds(settings.tier));
  return source.options.filter((option) => selected.has(option.id)).map((option) => option.id);
}

function effectiveSectionIds(settings: StoredSettings, source: StyleSource): string[] {
  return settings.tier === "normal" ? [] : selectedSectionIds(settings, source);
}

function normalizeStoredSettings(settings: StoredSettings, source: StyleSource): StoredSettings {
  if (settings.selectedSections === undefined) return settings;
  return { ...settings, selectedSections: selectedSectionIds(settings, source) };
}

function sameStoredSettings(left: StoredSettings, right: StoredSettings): boolean {
  if (left.tier !== right.tier || left.basePrompt !== right.basePrompt) return false;
  if (left.selectedSections === undefined || right.selectedSections === undefined) {
    return left.selectedSections === right.selectedSections;
  }
  return left.selectedSections.length === right.selectedSections.length &&
    left.selectedSections.every((id, index) => id === right.selectedSections?.[index]);
}

function fullSettingsPatch(settings: StoredSettings): SettingsPatch {
  return {
    tier: settings.tier,
    basePrompt: settings.basePrompt,
    selectedSections: settings.selectedSections === undefined ? null : settings.selectedSections,
  };
}

function buildStylePolicy(settings: StoredSettings, source: StyleSource): string | undefined {
  if (settings.tier === "normal") return undefined;
  const selected = new Set(effectiveSectionIds(settings, source));
  return [
    ...source.common,
    ...source.options.filter((option) => selected.has(option.id)).map((option) => option.content),
    source.tiers[settings.tier],
  ].join("\n\n");
}

function managedStyleBlock(stylePrompt: string | undefined): string | undefined {
  return stylePrompt ? `${PROMPT_START}\n${stylePrompt}\n${PROMPT_END}` : undefined;
}

function placeStylePromptAtAppendBoundary(
  basePrompt: string,
  appendSystemPrompt: string | undefined,
  stylePrompt: string | undefined,
): string {
  const block = managedStyleBlock(stylePrompt);
  if (!block) return basePrompt;

  const append = appendSystemPrompt?.trim();
  const appendIndex = append ? basePrompt.lastIndexOf(append) : -1;
  if (append && appendIndex >= 0) {
    const before = basePrompt.slice(0, appendIndex).replace(/\n+$/, "");
    const after = basePrompt.slice(appendIndex).replace(/^\n+/, "");
    return [before, block, after].filter(Boolean).join("\n\n");
  }
  return basePrompt ? `${basePrompt}\n\n${block}` : block;
}

function renderMinimalSystemPrompt(
  options: BuildSystemPromptOptions,
  stylePrompt: string | undefined,
): string {
  const parts = [options.customPrompt?.trim() || MINIMAL_BASE_PROMPT];
  const tools = (options.selectedTools ?? Object.keys(options.toolSnippets ?? {}))
    .filter((name) => options.toolSnippets?.[name])
    .map((name) => `- ${name}: ${options.toolSnippets?.[name]}`);
  if (tools.length > 0) parts.push(`Available tools:\n${tools.join("\n")}`);

  const guidelines = (options.promptGuidelines ?? [])
    .map((guideline) => guideline.trim())
    .filter(Boolean)
    .map((guideline) => `- ${guideline}`);
  if (guidelines.length > 0) parts.push(`Guidelines:\n${guidelines.join("\n")}`);

  for (const file of options.contextFiles ?? []) {
    parts.push(`## ${file.path}\n\n${file.content}`);
  }
  if (options.skills && options.skills.length > 0) {
    const skills = formatSkillsForPrompt(options.skills);
    if (skills.trim()) parts.push(skills);
  }
  parts.push(`Current working directory: ${options.cwd}`);

  const block = managedStyleBlock(stylePrompt);
  if (block) parts.push(block);
  const append = options.appendSystemPrompt?.trim();
  if (append) parts.push(append);
  return parts.join("\n\n");
}

async function readStoredSettings(): Promise<StoredSettings> {
  try {
    const root: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    if (!isJsonObject(root) || !isJsonObject(root[SETTINGS_KEY])) {
      return { tier: "normal", basePrompt: "default" };
    }

    const record = root[SETTINGS_KEY];
    const rawTier = record.tier;
    const tier = rawTier === "normal" || isTier(rawTier) ? rawTier : "normal";
    const basePrompt = record.basePrompt === "minimal" ? "minimal" : "default";
    const selectedSections = Array.isArray(record.selectedSections)
      ? [...new Set(record.selectedSections.filter((value): value is string => typeof value === "string"))]
      : undefined;
    return selectedSections === undefined
      ? { tier, basePrompt }
      : { tier, basePrompt, selectedSections };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { tier: "normal", basePrompt: "default" };
    }
    throw error;
  }
}

type SettingsPatch = {
  tier?: StoredTier;
  basePrompt?: BasePromptMode;
  selectedSections?: string[] | null;
};

function applySettingsPatch(settings: StoredSettings, patch: SettingsPatch): StoredSettings {
  const next: StoredSettings = {
    ...settings,
    tier: patch.tier ?? settings.tier,
    basePrompt: patch.basePrompt ?? settings.basePrompt,
  };
  if (patch.selectedSections === null) {
    delete next.selectedSections;
  } else if (patch.selectedSections !== undefined) {
    next.selectedSections = [...new Set(patch.selectedSections)];
  }
  return next;
}

function sourceSettingId(id: string): string {
  return `source:${id}`;
}

function sourceIdFromSetting(id: string): string | undefined {
  return id.startsWith("source:") ? id.slice("source:".length) : undefined;
}

function buildSettingsItems(
  section: SettingsSection,
  settings: StoredSettings,
  source: StyleSource,
): SettingsItem[] {
  if (section === "general") {
    const preset: SourcePreset = settings.selectedSections === undefined ? "tier-defaults" : "custom";
    return [
      {
        id: "tier",
        label: "Mode",
        description: "Response style and default source selection.",
        currentValue: settings.tier,
        values: ["normal", ...TIERS],
      },
      {
        id: "basePrompt",
        label: "Base prompt",
        description: "Keep Pi's default coding prompt or replace it with a compact general-purpose prompt.",
        currentValue: settings.basePrompt,
        values: ["default", "minimal"],
      },
      {
        id: "sourcePreset",
        label: "Source preset",
        description: "Follow the selected tier defaults or keep a custom section set.",
        currentValue: preset,
        values: [...SOURCE_PRESET_VALUES],
      },
    ];
  }

  const active = new Set(effectiveSectionIds(settings, source));
  const selected = new Set(selectedSectionIds(settings, source));
  return source.options
    .filter((option) => option.section === section)
    .map((option) => {
      const currentValue = active.has(option.id)
        ? "enabled"
        : selected.has(option.id)
          ? "selected"
          : "disabled";
      const values = settings.tier === "normal"
        ? currentValue === "selected"
          ? ["selected", "disabled"]
          : ["disabled", "selected"]
        : ["enabled", "disabled"];
      return {
        id: sourceSettingId(option.id),
        label: option.label,
        description: option.description,
        currentValue,
        values,
      };
    });
}

function adjacentSettingsSection(
  section: SettingsSection,
  direction: "forward" | "backward",
): SettingsSection {
  const index = SETTINGS_SECTIONS.indexOf(section);
  const offset = direction === "forward" ? 1 : -1;
  return SETTINGS_SECTIONS[(index + offset + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length];
}

function renderSettingsTabs(
  section: SettingsSection,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
): string {
  const tabs = SETTINGS_SECTIONS.map((candidate) => {
    const label = SETTINGS_SECTION_LABELS[candidate];
    return candidate === section
      ? theme.fg("accent", theme.bold(label))
      : theme.fg("muted", label);
  });
  const full = `  ${tabs.join(theme.fg("muted", " / "))}`;
  if (visibleWidth(full) <= width) return full;
  const index = SETTINGS_SECTIONS.indexOf(section);
  return `  ${theme.fg("accent", theme.bold(SETTINGS_SECTION_LABELS[section]))} ${theme.fg("dim", `(${index + 1}/${SETTINGS_SECTIONS.length})`)}`;
}

function wrapToWidth(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width));
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function settingsLayout(
  items: SettingsItem[],
  width: number,
): {
  inline: boolean;
  labelWidth: number;
  maxLabelWidth: number;
  rowHeights: number[];
  valueWidth: number;
} {
  const valueWidth = Math.max(...items.map((item) => visibleWidth(item.currentValue)));
  const maxLabelWidth = Math.max(...items.map((item) => visibleWidth(item.label)));
  const inlineLabelWidth = width - 2 - 2 - valueWidth;
  const inline = inlineLabelWidth >= 8;
  const labelWidth = inline
    ? Math.min(maxLabelWidth, inlineLabelWidth)
    : Math.max(1, width - 2);
  const rowHeights = items.map((item) => {
    const labelRows = wrapToWidth(item.label, labelWidth).length;
    return inline ? labelRows : labelRows + 1;
  });
  return { inline, labelWidth, maxLabelWidth, rowHeights, valueWidth };
}

function visibleSettingsRange(
  rowHeights: number[],
  selectedIndex: number,
  rowBudget: number,
): { start: number; end: number } {
  if (rowHeights.length === 0) return { start: 0, end: 0 };
  const selected = Math.min(Math.max(0, selectedIndex), rowHeights.length - 1);
  let start = selected;
  let end = selected + 1;
  let used = rowHeights[selected];

  while (true) {
    let expanded = false;
    if (start > 0 && used + rowHeights[start - 1] <= rowBudget) {
      start -= 1;
      used += rowHeights[start];
      expanded = true;
    }
    if (end < rowHeights.length && used + rowHeights[end] <= rowBudget) {
      used += rowHeights[end];
      end += 1;
      expanded = true;
    }
    if (!expanded) break;
  }
  return { start, end };
}

function renderSettingValue(
  value: string,
  theme: ExtensionContext["ui"]["theme"],
): string {
  if (value === "enabled") return theme.fg("success", theme.bold(value));
  if (value === "selected") return theme.fg("accent", theme.bold(value));
  if (value === "disabled" || value === "normal") return theme.fg("dim", value);
  if (value === "custom") return theme.fg("warning", theme.bold(value));
  return theme.fg("accent", theme.bold(value));
}

function paintSettingsRow(
  line: string,
  active: boolean,
  width: number,
  theme: ExtensionContext["ui"]["theme"],
): string {
  return active ? theme.bg("selectedBg", padToWidth(line, width)) : line;
}

function renderHelpLine(
  line: string,
  theme: ExtensionContext["ui"]["theme"],
): string {
  return line
    .split(/(Enter\/Space|Tab\/Shift\+Tab|Esc)/)
    .map((part) =>
      /^(Enter\/Space|Tab\/Shift\+Tab|Esc)$/.test(part)
        ? theme.fg("accent", theme.bold(part))
        : theme.fg("dim", part)
    )
    .join("");
}

function renderResponsiveSettings(
  items: SettingsItem[],
  selectedIndex: number,
  width: number,
  height: number,
  theme: ExtensionContext["ui"]["theme"],
): string[] {
  if (items.length === 0) return [theme.fg("muted", "  No settings in this section.")];

  const selected = Math.min(Math.max(0, selectedIndex), items.length - 1);
  const { inline, labelWidth, rowHeights } = settingsLayout(items, width);
  const description = items[selected]?.description;
  const descriptionLines = description
    ? wrapToWidth(description, Math.max(1, width - 4))
    : [];
  const helpLines = wrapToWidth(
    "Enter/Space to change · Tab/Shift+Tab to switch sections · Esc to close",
    Math.max(1, width - 2),
  );
  const contentHeight = Math.max(1, height - 4);
  const selectedRows = rowHeights[selected];
  const helpBlockRows = 1 + helpLines.length;
  const showHelp = contentHeight >= selectedRows + helpBlockRows;
  const descriptionBlockRows = descriptionLines.length > 0 ? 1 + descriptionLines.length : 0;
  const showDescription = descriptionBlockRows > 0 &&
    contentHeight >= selectedRows + (showHelp ? helpBlockRows : 0) + descriptionBlockRows;
  const fixedRows = (showHelp ? helpBlockRows : 0) + (showDescription ? descriptionBlockRows : 0);
  const allItemRows = rowHeights.reduce((sum, rows) => sum + rows, 0);
  const showIndicator = allItemRows > contentHeight - fixedRows;
  const rowBudget = Math.max(
    selectedRows,
    contentHeight - fixedRows - (showIndicator ? 1 : 0),
  );
  const { start, end } = visibleSettingsRange(rowHeights, selected, rowBudget);
  const window = items.slice(start, end);
  const lines: string[] = [];

  for (const [windowIndex, item] of window.entries()) {
    const itemIndex = start + windowIndex;
    const active = itemIndex === selected;
    const labelLines = wrapToWidth(item.label, labelWidth);
    const cursor = active ? theme.fg("accent", "→ ") : "  ";
    const renderLabel = (label: string) => active
      ? theme.fg("accent", theme.bold(label))
      : theme.fg("text", label);
    const pushRow = (line: string) => lines.push(paintSettingsRow(line, active, width, theme));

    if (inline) {
      pushRow(
        `${cursor}${renderLabel(padToWidth(labelLines[0] ?? "", labelWidth))}  ${renderSettingValue(item.currentValue, theme)}`,
      );
      for (const continuation of labelLines.slice(1)) {
        pushRow(`  ${renderLabel(continuation)}`);
      }
    } else {
      pushRow(`${cursor}${renderLabel(labelLines[0] ?? "")}`);
      for (const continuation of labelLines.slice(1)) pushRow(`  ${renderLabel(continuation)}`);
      pushRow(`  ${renderSettingValue(item.currentValue, theme)}`);
    }
  }

  if (start > 0 || end < items.length) {
    lines.push(
      `  ${theme.fg("dim", "(")}${theme.fg("accent", theme.bold(String(selected + 1)))}${theme.fg("dim", `/${items.length})`)}`,
    );
  }
  if (showDescription) {
    lines.push("");
    lines.push(
      ...descriptionLines.map((line, index) =>
        `${index === 0 ? theme.fg("accent", "  › ") : "    "}${theme.fg("text", line)}`
      ),
    );
  }
  if (showHelp) {
    lines.push("");
    lines.push(...helpLines.map((line) => renderHelpLine(`  ${line}`, theme)));
  }
  return lines;
}

async function saveStoredSettings(patch: SettingsPatch): Promise<void> {
  await withFileMutationQueue(SETTINGS_PATH, async () => {
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });

    let root: JsonObject = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
      if (!isJsonObject(parsed)) throw new Error(`${SETTINGS_PATH} must contain a JSON object`);
      root = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const current = isJsonObject(root[SETTINGS_KEY]) ? { ...root[SETTINGS_KEY] } : {};
    if (patch.tier !== undefined) current.tier = patch.tier;
    if (patch.basePrompt !== undefined) current.basePrompt = patch.basePrompt;
    if (patch.selectedSections === null) {
      delete current.selectedSections;
    } else if (patch.selectedSections !== undefined) {
      current.selectedSections = [...new Set(patch.selectedSections)];
    }

    const temporary = `${SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const mode = await stat(SETTINGS_PATH)
        .then((info) => info.mode & 0o777)
        .catch(() => 0o600);
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(`${JSON.stringify({ ...root, [SETTINGS_KEY]: current }, null, 2)}\n`, "utf8");
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
  let styleSource: StyleSource | undefined;
  let settings: StoredSettings = { tier: "normal", basePrompt: "default" };
  let settingsQueue: Promise<void> = Promise.resolve();

  const enqueueSettingsOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = settingsQueue.then(operation);
    settingsQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };
  const enqueueSettingsMutation = (patch: SettingsPatch): Promise<StoredSettings> =>
    enqueueSettingsOperation(async () => {
      const next = styleSource
        ? normalizeStoredSettings(applySettingsPatch(settings, patch), styleSource)
        : applySettingsPatch(settings, patch);
      await saveStoredSettings(fullSettingsPatch(next));
      settings = next;
      return settings;
    });
  const enqueueSettingsReload = (): Promise<StoredSettings> =>
    enqueueSettingsOperation(async () => {
      const loaded = await readStoredSettings();
      const next = styleSource ? normalizeStoredSettings(loaded, styleSource) : loaded;
      if (!sameStoredSettings(loaded, next)) await saveStoredSettings(fullSettingsPatch(next));
      settings = next;
      return settings;
    });

  const [sourceResult, settingsResult] = await Promise.allSettled([
    loadStyleSource(),
    readStoredSettings(),
  ]);
  if (sourceResult.status === "fulfilled") styleSource = sourceResult.value;
  if (settingsResult.status === "fulfilled") {
    settings = styleSource
      ? normalizeStoredSettings(settingsResult.value, styleSource)
      : settingsResult.value;
  }

  pi.on("session_start", async (_event, ctx) => {
    const failures: string[] = [];
    if (!styleSource) {
      try {
        styleSource = await loadStyleSource();
      } catch (error) {
        failures.push(`sources: ${String(error)}`);
      }
    }
    try {
      await enqueueSettingsReload();
    } catch (error) {
      failures.push(`settings: ${String(error)}`);
    }
    if (failures.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`Could not initialize Pohuy (${failures.join("; ")})`, "error");
    }
  });

  pi.registerCommand("pohuy", {
    description: "Configure Pohuy response style and prompt sources",
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

      if (tokens.length === 0) {
        try {
          styleSource ??= await loadStyleSource();
        } catch (error) {
          if (ctx.hasUI) ctx.ui.notify(`Could not load Pohuy sources: ${String(error)}`, "error");
          return;
        }
        const source = styleSource;
        const mode = (ctx as typeof ctx & { mode?: string }).mode;
        if (!ctx.hasUI || (mode !== undefined && mode !== "tui")) {
          if (ctx.hasUI) ctx.ui.notify("Pohuy settings UI is available only in TUI mode.", "warning");
          return;
        }

        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          let applying = false;
          let activeSection: SettingsSection = "general";
          const selectedIndexes: Record<SettingsSection, number> = {
            general: 0,
            skill: 0,
            dictionary: 0,
            scenes: 0,
          };
          const currentItems = () => buildSettingsItems(activeSection, settings, source);
          const clampSelection = () => {
            const items = currentItems();
            selectedIndexes[activeSection] = Math.min(
              Math.max(0, selectedIndexes[activeSection]),
              Math.max(0, items.length - 1),
            );
          };
          const switchSection = (direction: "forward" | "backward") => {
            activeSection = adjacentSettingsSection(activeSection, direction);
            clampSelection();
            tui.requestRender();
          };
          const applyCurrentSetting = () => {
            if (applying) return;
            const items = currentItems();
            const item = items[selectedIndexes[activeSection]];
            if (!item || item.values.length < 2) return;
            const valueIndex = item.values.indexOf(item.currentValue);
            const newValue = item.values[(Math.max(0, valueIndex) + 1) % item.values.length];
            let patch: SettingsPatch | undefined;
            let notification: string | undefined;

            if (item.id === "tier" && (newValue === "normal" || isTier(newValue))) {
              patch = { tier: newValue };
              notification = `Pohuy mode: ${newValue}`;
            } else if (item.id === "basePrompt" && (newValue === "default" || newValue === "minimal")) {
              patch = { basePrompt: newValue };
              notification = `Pohuy base prompt: ${newValue}`;
            } else if (
              item.id === "sourcePreset" &&
              SOURCE_PRESET_VALUES.includes(newValue as SourcePreset)
            ) {
              patch = newValue === "tier-defaults"
                ? { selectedSections: null }
                : { selectedSections: selectedSectionIds(settings, source) };
              notification = `Pohuy source preset: ${newValue}`;
            } else {
              const optionId = sourceIdFromSetting(item.id);
              const option = source.options.find((candidate) => candidate.id === optionId);
              if (option && FEATURE_STATE_VALUES.includes(newValue as FeatureState)) {
                const selected = new Set(selectedSectionIds(settings, source));
                if (newValue === "enabled" || newValue === "selected") selected.add(option.id);
                else selected.delete(option.id);
                patch = { selectedSections: [...selected] };
                notification = `${option.label}: ${newValue}`;
              }
            }
            if (!patch) return;

            applying = true;
            void enqueueSettingsMutation(patch)
              .then(() => {
                clampSelection();
                ctx.ui.notify(notification ?? "Pohuy settings updated.", "info");
              })
              .catch((error) => {
                ctx.ui.notify(`Could not update Pohuy settings: ${String(error)}`, "error");
              })
              .finally(() => {
                applying = false;
                tui.requestRender();
              });
          };

          return {
            render(width: number) {
              const border = theme.fg("border", "─".repeat(Math.max(0, width)));
              return [
                border,
                renderSettingsTabs(activeSection, theme, width),
                border,
                ...renderResponsiveSettings(
                  currentItems(),
                  selectedIndexes[activeSection],
                  width,
                  tui.terminal.rows,
                  theme,
                ),
                border,
              ].map((line) => truncateToWidth(line, width, ""));
            },
            invalidate() {},
            handleInput(data: string) {
              if (matchesKey(data, Key.tab)) {
                switchSection("forward");
                return;
              }
              if (matchesKey(data, Key.shift("tab"))) {
                switchSection("backward");
                return;
              }
              const items = currentItems();
              if (matchesKey(data, Key.up)) {
                selectedIndexes[activeSection] = Math.max(0, selectedIndexes[activeSection] - 1);
              } else if (matchesKey(data, Key.down)) {
                selectedIndexes[activeSection] = Math.min(
                  Math.max(0, items.length - 1),
                  selectedIndexes[activeSection] + 1,
                );
              } else if (matchesKey(data, Key.home)) {
                selectedIndexes[activeSection] = 0;
              } else if (matchesKey(data, Key.end)) {
                selectedIndexes[activeSection] = Math.max(0, items.length - 1);
              } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
                applyCurrentSetting();
                return;
              } else if (matchesKey(data, Key.escape)) {
                done(undefined);
                return;
              } else {
                return;
              }
              tui.requestRender();
            },
          };
        });
        return;
      }

      const value = tokens[0];
      const tier: StoredTier | undefined = value === "normal" ? value : isTier(value) ? value : undefined;
      if (!tier) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
        return;
      }

      try {
        if (tier !== "normal") styleSource ??= await loadStyleSource();
        await enqueueSettingsMutation({ tier });
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Could not save Pohuy settings: ${String(error)}`, "error");
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(
          tier === "normal" ? "Pohuy disabled. Normal mode restored." : `Pohuy enabled: ${tier}.`,
          "info",
        );
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const phrase = event.text.trim().toLowerCase().replace(/[.!?]+$/, "");
    const tier = ENABLE_PHRASES.has(phrase) ? "full" : DISABLE_PHRASES.has(phrase) ? "normal" : undefined;
    if (!tier) return { action: "continue" };

    try {
      if (tier !== "normal") styleSource ??= await loadStyleSource();
      await enqueueSettingsMutation({ tier });
      if (ctx.hasUI) {
        ctx.ui.notify(
          tier === "normal" ? "Pohuy disabled. Normal mode restored." : "Pohuy enabled: full.",
          "info",
        );
      }
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Could not save Pohuy settings: ${String(error)}`, "error");
    }

    return { action: "continue" };
  });

  pi.on("before_agent_start", (event) => {
    const policy = styleSource ? buildStylePolicy(settings, styleSource) : undefined;
    const stylePrompt = policy && settings.tier !== "normal"
      ? [
        "Active session style: pohuy. Apply this policy only to natural-language assistant responses.",
        policy,
        `Selected tier: ${settings.tier}. Keep it until /pohuy or a documented natural-language switch changes it.`,
        "Do not alter tool calls, tool results, structured output, or higher-priority instructions.",
      ].join("\n\n")
      : undefined;

    if (settings.basePrompt === "minimal") {
      return {
        systemPrompt: renderMinimalSystemPrompt(event.systemPromptOptions, stylePrompt),
      };
    }
    if (!stylePrompt) return;
    return {
      systemPrompt: placeStylePromptAtAppendBoundary(
        event.systemPrompt,
        event.systemPromptOptions.appendSystemPrompt,
        stylePrompt,
      ),
    };
  });
}
