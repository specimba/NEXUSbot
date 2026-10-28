/** Shared client-side shapes for panel API responses. */

export type PanelEvent = {
  id: string;
  ts: string;
  source: string;
  type: string;
  level: "debug" | "info" | "warn" | "error" | string;
  actor: string | null;
  payload: string;
  createdAt: string;
};

export type PanelStats = {
  eventsTotal: number;
  tokensActive: number;
  credentialsTotal: number;
  uptimeSec: number;
};

export type IngestTokenRow = {
  id: string;
  label: string;
  preview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CredentialRow = {
  id: string;
  service: string;
  label: string;
  keyId: string;
  masked: string;
  updatedAt: string;
};

export type BudgetRow = {
  key: string;
  value: number;
};

export type ApiError = { ok: false; error: { code: string; message: string } };
