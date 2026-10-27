'use client'

// DevActions (T-109, FR-08/28/31): the operator's M1 levers at the top of the
// Pipeline tab. Every button calls a real session-gated endpoint, reports the
// SERVER-returned numbers in the toast (no invented results), and invalidates
// the queries its effect touches. 44px touch targets per FR-10.

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { DatabaseBackup, FlaskConical, Recycle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'
import { backup, retention, seed } from '@/lib/api-client'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DevActions() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<null | 'seed' | 'backup' | 'retention'>(null)

  /** Invalidate everything these dev effects can touch (events fan out). */
  async function invalidateAfterAction() {
    await queryClient.invalidateQueries({ queryKey: ['metrics'] })
    await queryClient.invalidateQueries({ queryKey: ['events'] })
    await queryClient.invalidateQueries({ queryKey: ['jobs'] })
    await queryClient.invalidateQueries({ queryKey: ['artifacts'] })
    await queryClient.invalidateQueries({ queryKey: ['dlq'] })
  }

  async function runSeed() {
    setBusy('seed')
    try {
      const result = await seed(20)
      toast({
        title: 'Seed complete',
        description: `eventsCreated: ${result.eventsCreated} · jobsQueued: ${result.jobsQueued} (synthetic, server-stamped)`,
      })
      await invalidateAfterAction()
    } catch (err) {
      toast({
        title: 'Seed failed',
        description: err instanceof Error ? err.message : 'Unexpected error',
        variant: 'destructive',
      })
    } finally {
      setBusy(null)
    }
  }

  async function runBackup() {
    setBusy('backup')
    try {
      const result = await backup()
      toast({
        title: 'Backup complete',
        description: `artifact #${result.backupId} · ${formatBytes(result.bytes)} · ${result.elapsedMs} ms`,
      })
      await invalidateAfterAction()
    } catch (err) {
      toast({
        title: 'Backup failed',
        description: err instanceof Error ? err.message : 'Unexpected error',
        variant: 'destructive',
      })
    } finally {
      setBusy(null)
    }
  }

  async function runRetention() {
    setBusy('retention')
    try {
      const result = await retention()
      toast({
        title: 'Retention sweep complete',
        description: `eventsDeleted: ${result.eventsDeleted} · artifactsDeleted: ${result.artifactsDeleted} · backupsPruned: ${result.backupsPruned}`,
      })
      await invalidateAfterAction()
    } catch (err) {
      toast({
        title: 'Retention sweep failed',
        description: err instanceof Error ? err.message : 'Unexpected error',
        variant: 'destructive',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Dev actions</CardTitle>
        <CardDescription>
          Synthetic load, backups, and retention — session-gated endpoints, results as returned by
          the server.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          onClick={runSeed}
          disabled={busy !== null}
        >
          <FlaskConical className="size-4" aria-hidden="true" />
          {busy === 'seed' ? 'Seeding…' : 'Seed 20 synthetic'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          onClick={runBackup}
          disabled={busy !== null}
        >
          <DatabaseBackup className="size-4" aria-hidden="true" />
          {busy === 'backup' ? 'Backing up…' : 'Backup now'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          onClick={runRetention}
          disabled={busy !== null}
        >
          <Recycle className="size-4" aria-hidden="true" />
          {busy === 'retention' ? 'Sweeping…' : 'Retention sweep'}
        </Button>
      </CardContent>
    </Card>
  )
}
