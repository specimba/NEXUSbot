"use client";

import { CustomProvidersCard } from "@/components/panel/connectors/custom-providers-card";
import { ExaCard } from "@/components/panel/connectors/exa-card";
import { ExaResearchCard } from "@/components/panel/connectors/exa-research-card";
import { GitHubCard } from "@/components/panel/connectors/github-card";
import { HyperbrowserCard } from "@/components/panel/connectors/hyperbrowser-card";
import { KickCard } from "@/components/panel/connectors/kick-card";
import { SpotifyCard } from "@/components/panel/connectors/spotify-card";
import { SupabaseCard } from "@/components/panel/connectors/supabase-card";
import { UpstashCard } from "@/components/panel/connectors/upstash-card";
import { VyceCard } from "@/components/panel/connectors/vyce-card";
import { WebshareCard } from "@/components/panel/connectors/webshare-card";

/**
 * Connectors tab — the wave-2 connector cards + the Vyce brain gateway
 * (T-207) + the owner-defined custom providers (OpenAI-/Anthropic-compatible
 * entry point). Task 30 puts the official Kick connection FIRST (the owner's
 * active ask); each card is honest by design: with an empty vault every card
 * shows its NOT CONFIGURED state and
 * the owner re-enters credentials in-place (R11 vault was reset with the
 * sandbox).
 */
export function ConnectorsTab() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2 [&>*]:min-w-0">
        <KickCard />
        <SpotifyCard />
        <ExaCard />
        <VyceCard />
        <SupabaseCard />
        <UpstashCard />
        <HyperbrowserCard />
        <WebshareCard />
        <GitHubCard />
      </div>
      {/* v33 — MOUNTED (was dead code since 15-b): the Deep Research card is
       * the panel lane of the same Exa Agent engine the chat now uses —
       * launch a run, watch the ledger, read the AI News Radar. Sits between
       * the connector grid and the custom providers, full-width. */}
      <ExaResearchCard />
      <CustomProvidersCard />
    </div>
  );
}
