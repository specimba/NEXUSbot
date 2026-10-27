// Tab registry — FROZEN contract (spec §3): `{ id, label, icon, order,
// requiredCredential? }`. The shell renders tabs FROM this array, never a
// hardcoded list. New tab = new entry here + a module; no shell rework (A4).
//
// `icon` is the lucide-react icon NAME string; the shell maps names to
// components (keeps this module dependency-free and serializable).

export interface TabDefinition {
  id: string
  label: string
  icon: string // lucide icon name, mapped in the shell
  order: number
  requiredCredential?: string // unused in M1 — every surface is session-gated
}

export const TAB_REGISTRY: TabDefinition[] = [
  { id: 'overview', label: 'Overview', icon: 'LayoutDashboard', order: 1 },
  { id: 'pipeline', label: 'Pipeline', icon: 'GitBranch', order: 2 },
  { id: 'stream', label: 'Stream', icon: 'Radio', order: 3 },
  { id: 'connectors', label: 'Connectors', icon: 'Plug', order: 4 },
  { id: 'eval', label: 'Eval', icon: 'FlaskConical', order: 5 },
  { id: 'settings', label: 'Settings', icon: 'Settings', order: 6 },
]

/** Registry entries in display order. */
export function orderedTabs(): TabDefinition[] {
  return [...TAB_REGISTRY].sort((a, b) => a.order - b.order)
}

/** True when the id exists in the frozen registry (guards tab state). */
export function isKnownTab(id: string): boolean {
  return TAB_REGISTRY.some((t) => t.id === id)
}
