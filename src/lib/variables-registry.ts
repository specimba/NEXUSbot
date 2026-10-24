/**
 * NEXUS OS — command-variable registry (Kickbot-parity P0).
 *
 * Canonical dialect (from the R-1 Kickbot docs research, worklog Task R-1):
 *   {{namespace.field}}  and  {{fn(args)}}
 * Namespaces: sender, streamer, target (tagged user), stream, plus function
 * namespaces random/randomRange/randomItem/randomItemPercentage/request.
 * Documented dialect exceptions: the clip command uses single braces
 * ({user}, {clip_url}) and chat alerts use flat {{username}}/{{months}}/
 * {{sub_count}}/{{amount}}; overlays expose {{viewer_count}}/{{follower_count}}.
 *
 * This registry is the single source of truth consumed by the Variables page
 * (reference + copy + TRY renderer) and later by the custom-commands builder.
 */

export type VariableAvailability = "command" | "widget" | "alert";

export type RegistryVariable = {
  /** Canonical syntax as typed by the streamer, e.g. "{{sender.username}}" */
  syntax: string;
  /** Short human label */
  label: string;
  /** What it resolves to */
  description: string;
  /** Sample resolved value used by the TRY renderer */
  sample: string;
  /** Where the variable is honored */
  availableIn: VariableAvailability[];
};

export type RegistryGroup = {
  id: string;
  name: string;
  /** When the namespace has a value at all (e.g. target requires tagging someone) */
  precondition?: string;
  variables: RegistryVariable[];
};

const SOCIAL_FIELDS: Array<{ field: string; label: string; sample: string }> = [
  { field: "username", label: "Username", sample: "speci" },
  { field: "followers", label: "Follower count", sample: "1,337" },
  { field: "url", label: "Channel URL", sample: "kick.com/speci" },
  { field: "bio", label: "Profile bio", sample: "L0 stream · local-first" },
  { field: "instagram", label: "Instagram handle", sample: "speci.dev" },
  { field: "twitter", label: "X / Twitter handle", sample: "speci_dev" },
  { field: "youtube", label: "YouTube channel", sample: "@speci" },
  { field: "discord", label: "Discord invite/handle", sample: "discord.gg/nexus" },
  { field: "tiktok", label: "TikTok handle", sample: "@speci" },
  { field: "facebook", label: "Facebook page", sample: "fb.me/speci" },
];

function socialGroup(
  id: string,
  name: string,
  namespace: string,
  precondition: string | undefined,
  withFollowage: boolean,
): RegistryGroup {
  const vars: RegistryVariable[] = SOCIAL_FIELDS.map((f) => ({
    syntax: `{{${namespace}.${f.field}}}`,
    label: f.label,
    description: `${f.label} of the ${namespace === "target" ? "tagged user" : namespace}.`,
    sample: f.sample,
    availableIn: ["command", "alert"],
  }));
  if (withFollowage) {
    vars.splice(2, 0, {
      syntax: `{{${namespace}.followage}}`,
      label: "Follow age",
      description: "How long the user has been following (humanized).",
      sample: "7 months",
      availableIn: ["command", "alert"],
    });
  }
  return { id, name, precondition, variables: vars };
}

export const VARIABLE_GROUPS: RegistryGroup[] = [
  socialGroup("sender", "Sender", "sender", undefined, true),
  socialGroup("streamer", "Streamer", "streamer", undefined, false),
  socialGroup(
    "target",
    "Tagged user",
    "target",
    "Only resolves when the command invoker tags someone — the tagged user's data.",
    true,
  ),
  {
    id: "param",
    name: "Command parameter",
    variables: [
      {
        syntax: "{{param}}",
        label: "Raw parameter",
        description: "Everything the invoker typed after the command, verbatim.",
        sample: "hello stream!",
        availableIn: ["command"],
      },
    ],
  },
  {
    id: "stream",
    name: "Stream",
    variables: [
      {
        syntax: "{{stream.title}}",
        label: "Stream title",
        description: "Current stream title.",
        sample: "NEXUS OS — bot integration live test",
        availableIn: ["command", "widget", "alert"],
      },
      {
        syntax: "{{stream.category}}",
        label: "Stream category",
        description: "Current category/game.",
        sample: "Software & Game Dev",
        availableIn: ["command", "widget", "alert"],
      },
      {
        syntax: "{{stream.viewers}}",
        label: "Viewer count",
        description: "Live viewer count (updates a few times per minute).",
        sample: "37",
        availableIn: ["command", "widget", "alert"],
      },
    ],
  },
  {
    id: "random",
    name: "Random functions",
    variables: [
      {
        syntax: "{{randomRange(min,max)}}",
        label: "Random integer range",
        description: "Uniform random integer between min and max (inclusive).",
        sample: "42",
        availableIn: ["command", "alert"],
      },
      {
        syntax: "{{randomItem(a,b,c)}}",
        label: "Random pick",
        description: "Uniform random pick from the comma-separated items.",
        sample: "b",
        availableIn: ["command", "alert"],
      },
      {
        syntax: '{{randomItemPercentage("a":70,"b":30)}}',
        label: "Weighted random pick",
        description: 'Weighted pick — e.g. "a" 70% / "b" 30%.',
        sample: "a",
        availableIn: ["command", "alert"],
      },
    ],
  },
  {
    id: "request",
    name: "Request (GET API)",
    precondition:
      "GET-only. Resolved server-side at runtime; the panel never fetches the URL for you.",
    variables: [
      {
        syntax: '{{request("https://api.example.com/v1/data").data[0].field}}',
        label: "API JSON path",
        description:
          "Fetch a GET URL and walk the JSON path (e.g. .data[0].field). GET-only by design.",
        sample: "[resolved at runtime → GET api.example.com/v1/data → data[0].field]",
        availableIn: ["command"],
      },
    ],
  },
  {
    id: "alerts",
    name: "Chat-alert context",
    precondition: "Only inside chat-alert templates (event payloads).",
    variables: [
      {
        syntax: "{{username}}",
        label: "Alert user",
        description: "User the alert is about.",
        sample: "nexus_fan",
        availableIn: ["alert"],
      },
      {
        syntax: "{{months}}",
        label: "Sub months",
        description: "Consecutive sub months (sub alerts).",
        sample: "6",
        availableIn: ["alert"],
      },
      {
        syntax: "{{sub_count}}",
        label: "Sub count",
        description: "Channel sub count (sub-goals).",
        sample: "212",
        availableIn: ["alert"],
      },
      {
        syntax: "{{amount}}",
        label: "Amount",
        description: "Gift/raid amount where applicable.",
        sample: "5",
        availableIn: ["alert"],
      },
    ],
  },
  {
    id: "overlays",
    name: "Overlay widgets",
    precondition: "Widget text templating (viewer widgets).",
    variables: [
      {
        syntax: "{{viewer_count}}",
        label: "Viewer count",
        description: "Live viewers in widget text (e.g. \"Viewers: {{viewer_count}}\").",
        sample: "37",
        availableIn: ["widget"],
      },
      {
        syntax: "{{follower_count}}",
        label: "Follower count",
        description: "Follower total in widget text.",
        sample: "1,337",
        availableIn: ["widget"],
      },
    ],
  },
];

/** Dialect exceptions worth surfacing verbatim (R-1: documented Kickbot quirks). */
export const DIALECT_NOTES: string[] = [
  "Standard namespace syntax is {{namespace.field}} — double braces.",
  "The clip command is a documented exception and uses single braces: {user}, {clip_url}.",
  "Chat-alert templates use the flat context ({{username}}, {{months}}, {{sub_count}}, {{amount}}) — no namespace prefix.",
  "Overlay widget text uses {{viewer_count}} / {{follower_count}} — also flat, no namespace.",
];

const SAMPLE_BY_SYNTAX = new Map<string, string>(
  VARIABLE_GROUPS.flatMap((g) => g.variables).map((v) => [v.syntax, v.sample]),
);

function randomInt(min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Deterministic-unless-random TRY renderer (client-side only).
 * - {{ns.field}} → sample map, unknown stays visible with ⚠
 * - randomRange / randomItem / randomItemPercentage → rolled per render
 * - request("url").path → honest runtime placeholder (panel never fetches)
 * - {single_brace} clip dialect → left untouched, flagged in the output note
 */
export function renderTemplate(tpl: string): string {
  return tpl
    .replace(/\{\{randomRange\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\}\}/gi, (_m, a, b) =>
      String(randomInt(Number(a), Number(b))),
    )
    .replace(/\{\{randomItem\(([^}]*)\)\}\}/gi, (_m, args) => {
      const items = String(args)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      return items.length ? items[randomInt(0, items.length - 1)] : "⚠ empty randomItem";
    })
    .replace(/\{\{randomItemPercentage\(([^}]*)\)\}\}/gi, (_m, args) => {
      const pairs = [...String(args).matchAll(/"([^"]+)"\s*:\s*(\d+)/g)].map((m) => ({
        item: m[1],
        weight: Number(m[2]),
      }));
      const total = pairs.reduce((s, p) => s + p.weight, 0);
      if (!pairs.length || total <= 0) return "⚠ bad randomItemPercentage";
      let roll = Math.random() * total;
      for (const p of pairs) {
        roll -= p.weight;
        if (roll < 0) return p.item;
      }
      return pairs[pairs.length - 1].item;
    })
    .replace(/\{\{request\("([^"]+)"\)((?:\.[A-Za-z0-9_]+|\[\d+\])*)\}\}/g, (_m, url, path) =>
      `[runtime GET ${url} → ${String(path).replace(/^\./, "")}]`,
    )
    .replace(/\{\{([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+)\}\}/g, (m, key: string) => {
      const sample = SAMPLE_BY_SYNTAX.get(`{{${key}}}`);
      return sample ?? `⚠ unknown ${m}`;
    })
    .replace(/\{\{(viewer_count|follower_count|username|months|sub_count|amount)\}\}/g, (m, key: string) =>
      SAMPLE_BY_SYNTAX.get(`{{${key}}}`) ?? m,
    );
}
