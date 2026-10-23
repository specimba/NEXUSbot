"use client";

import { GitHubCard } from "@/components/panel/connectors/github-card";
import { HyperbrowserCard } from "@/components/panel/connectors/hyperbrowser-card";
import { SupabaseCard } from "@/components/panel/connectors/supabase-card";
import { UpstashCard } from "@/components/panel/connectors/upstash-card";
import { VyceCard } from "@/components/panel/connectors/vyce-card";
import { WebshareCard } from "@/components/panel/connectors/webshare-card";

/**
 * Connectors tab — the wave-2 connector cards + the Vyce brain gateway
 * (T-207). Order follows the T-2xx build sequence; each card is honest by
 * design: with an empty vault every card shows its NOT CONFIGURED state and
 * the owner re-enters credentials in-place (R11 vault was reset with the
 * sandbox).
 */
export function ConnectorsTab() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <GitHubCard />
      <SupabaseCard />
      <UpstashCard />
      <HyperbrowserCard />
      <WebshareCard />
      <VyceCard />
    </div>
  );
}
