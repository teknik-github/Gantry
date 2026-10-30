import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"

// Runs after the "login" project, which creates the ADMIN account.
// Download a backup, change something, restore it: the change is undone and
// everyone has to sign in again. Then scheduled (stored) backups.
test.describe.configure({ mode: "serial" })

const PASS = "e2e backup passphrase 42"
const TEMPLATE = `E2E backup template ${Date.now().toString(36)}`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-e2e-backup-"))

test.afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

const field = (page: Page, name: string) => page.getByLabel(name, { exact: true })

test("a downloaded backup restores the data it was taken with", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await page.goto("/backups")

  // Passphrases are checked before anything is made.
  await field(page, "Passphrase").first().fill("short")
  await field(page, "Repeat passphrase").fill("short")
  await page.getByRole("button", { name: "Download backup" }).click()
  await expect(page.getByText("Use at least 12 characters")).toBeVisible()

  await field(page, "Passphrase").first().fill(PASS)
  await field(page, "Repeat passphrase").fill(PASS)
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download backup" }).click()
  const file = path.join(tmp, (await download).suggestedFilename())
  await (await download).saveAs(file)
  expect(path.basename(file)).toMatch(/^gantry-backup-\d{8}-\d{6}Z\.gbk$/)
  expect(fs.readFileSync(file).subarray(0, 13).toString()).toBe("GANTRY-BACKUP")

  // A change made after the backup.
  await page.goto("/templates/new")
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(TEMPLATE)
  await page.getByRole("textbox", { name: "Default stack name", exact: true }).fill("backup-check")
  await page.getByRole("button", { name: "Save template" }).click()
  await expect(page).toHaveURL(/\/templates\/c-\d+$/)

  await page.goto("/backups")
  const restore = page.locator("form").filter({ has: page.getByRole("button", { name: "Restore" }) })
  await restore.getByLabel("Backup file").setInputFiles(file)
  await restore.getByLabel("Passphrase").fill("not the passphrase")
  await restore.getByLabel("Type RESTORE").fill("RESTORE")
  await restore.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByText("Wrong passphrase, or the file is damaged")).toBeVisible({ timeout: 30_000 })

  await restore.getByLabel("Passphrase").fill(PASS)
  await restore.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByTestId("restore-done")).toContainText("Restored", { timeout: 60_000 })

  // Everyone is signed out; the template made after the backup is gone.
  await page.getByRole("button", { name: "Sign in again" }).click()
  await expect(page).toHaveURL(/\/login/)
  await signIn(page)
  await page.goto("/templates")
  await expect(page.getByRole("link", { name: `Template ${TEMPLATE}` })).toHaveCount(0)
  await page.goto("/activity")
  await expect(page.getByRole("row").filter({ hasText: "backup.restore" }).first()).toBeVisible()
})

test("scheduled backups are written with the stored passphrase, listed, downloadable and deletable", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await page.goto("/backups")
  await expect(page.getByRole("button", { name: "Back up now" })).toBeDisabled()

  const schedule = page.locator("form").filter({ has: page.getByRole("button", { name: "Save schedule" }) })
  await schedule.getByLabel("Keep").fill("3")
  await schedule.getByLabel("Passphrase").fill(PASS)
  await schedule.getByRole("button", { name: "Save schedule" }).click()
  await expect(page.getByText("Scheduled backups are off")).toBeVisible()

  await page.getByRole("button", { name: "Back up now" }).click()
  await expect(page.getByText(/^Backup gantry-backup-.*\.gbk written/)).toBeVisible({ timeout: 60_000 })
  const row = page.getByRole("row").filter({ hasText: /gantry-backup-\d{8}-\d{6}Z\.gbk/ }).first()
  await expect(row).toBeVisible()
  await expect(page.getByTestId("backup-last")).toContainText("gantry-backup-")

  const name = (await row.getByRole("link").getAttribute("aria-label"))!.replace(/^Download /, "")
  const res = await page.request.get(`/api/backup/files/${name}`)
  expect(res.status()).toBe(200)
  expect((await res.body()).subarray(0, 13).toString()).toBe("GANTRY-BACKUP")
  expect((await page.request.get("/api/backup/files/..%2Fsecret.key")).status()).toBe(404)

  await row.getByRole("button", { name: `Delete ${name}` }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0)
})

test("only administrators can make or restore backups", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL })
  expect((await anon.post("/api/backup", { data: { passphrase: PASS } })).status()).toBe(401)
  expect((await anon.post("/api/backup/restore")).status()).toBe(401)
  await anon.dispose()
})
