import type { Metadata } from "next"

import { BackupDownload, BackupSchedule, RestoreBackup, StoredBackupsTable } from "@/components/gantry/backups-ui"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { requireAdmin } from "@/lib/server/auth/dal"
import { backupDir, getBackupSchedule, lastBackup, listStoredBackups } from "@/lib/server/backup"
import { MIN_PASSPHRASE } from "@/lib/server/backup-format"
import { getI18n } from "@/lib/i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.backups }
}

export default async function BackupsPage() {
  await requireAdmin()
  const [schedule, last, stored] = await Promise.all([getBackupSchedule(), lastBackup(), listStoredBackups()])
  const { t, timeAgo, formatBytes } = await getI18n()

  return (
    <PageBody>
      <PageHeader
        title={t.nav.pages.backups}
        description={t.backups.description}
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
