import type { Metadata } from "next"

import { BackupDownload, BackupSchedule, RestoreBackup, StoredBackupsTable } from "@/components/gantry/backups-ui"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { formatBytes, timeAgo } from "@/lib/format"
import { requireAdmin } from "@/lib/server/auth/dal"
import { backupDir, getBackupSchedule, lastBackup, listStoredBackups } from "@/lib/server/backup"
import { MIN_PASSPHRASE } from "@/lib/server/backup-format"

export const metadata: Metadata = { title: "Backups" }

export default async function BackupsPage() {
  await requireAdmin()
  const [schedule, last, stored] = await Promise.all([getBackupSchedule(), lastBackup(), listStoredBackups()])

  return (
    <PageBody>
      <PageHeader
        title="Backups"
        description="A backup holds all of Gantry's data (environments, users, stacks, settings…) and the secret its encrypted values need, sealed with your passphrase. It can be restored into SQLite or MySQL."
      />
      <BackupDownload minPassphrase={MIN_PASSPHRASE} />
      <BackupSchedule
        enabled={schedule.enabled}
        time={schedule.time}
        keep={schedule.keep}
        hasPassphrase={schedule.hasPassphrase}
        directory={backupDir()}
        minPassphrase={MIN_PASSPHRASE}
        last={last ? { ...last, label: timeAgo(last.at) } : null}
      />
      <StoredBackupsTable
        data={stored.map((b) => ({ ...b, sizeLabel: formatBytes(b.size), createdLabel: timeAgo(b.createdAt) }))}
      />
      <RestoreBackup />
    </PageBody>
  )
}
