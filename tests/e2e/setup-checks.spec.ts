import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"

// Runs after the "login" project, which creates the ADMIN account.
test.describe.configure({ mode: "serial" })

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

test("the dashboard lists what an administrator still has to set up", async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  const card = page.getByTestId("setup-checks")
  await expect(card).toBeVisible({ timeout: 60_000 })
  // Reached on 127.0.0.1: plain HTTP is fine locally, so no HTTPS warning.
  await expect(card.locator('[data-check="https"]')).toHaveCount(0)
  await expect(card.locator('[data-check="backups"]')).toBeVisible()
  await expect(card.locator('[data-check="notifications"]')).toBeVisible()

  // Scheduling backups clears that check.
  await card.locator('[data-check="backups"]').getByRole("link", { name: "Set up backups" }).click()
  await expect(page).toHaveURL(/\/backups$/)
  const schedule = page.locator("form").filter({ has: page.getByRole("button", { name: "Save schedule" }) })
  await schedule.getByRole("checkbox", { name: "Back up every day" }).click()
  await schedule.getByLabel("Passphrase").fill("setup checks passphrase")
  await schedule.getByRole("button", { name: "Save schedule" }).click()
  await expect(page.getByText(/^Backups run daily at/)).toBeVisible()

  await page.goto("/dashboard")
  await expect(page.getByTestId("setup-checks").locator('[data-check="backups"]')).toHaveCount(0, { timeout: 60_000 })

  // Back off, as the other specs expect.
  await page.goto("/backups")
  await schedule.getByRole("checkbox", { name: "Back up every day" }).click()
  await schedule.getByRole("button", { name: "Save schedule" }).click()
  await expect(page.getByText("Scheduled backups are off")).toBeVisible()
})
