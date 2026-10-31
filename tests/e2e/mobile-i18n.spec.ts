import { expect, test, type Page } from "@playwright/test"

import { en } from "@/lib/i18n/dictionaries/en"
import { id } from "@/lib/i18n/dictionaries/id"

import { ADMIN } from "./credentials"
import { dockerAvailable, removeContainer, startScratchContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
// The language is a per-browser cookie, so switching it here doesn't leak
// into other specs (each test gets a fresh browser context).
test.describe.configure({ mode: "serial" })

const CONTAINER = "gantry-test-m-mobile"
// E2E_MOBILE_SCREENSHOTS=/tmp saves a screenshot of each page checked on the phone.
const SCREENSHOTS = process.env.E2E_MOBILE_SCREENSHOTS

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]')

test("switches the interface to Indonesian and back", async ({ page }) => {
  await signIn(page)
  await expect(page.locator("html")).toHaveAttribute("lang", "en")

  // User menu → Language → Bahasa Indonesia (reloads the page).
  await page.locator('[data-slot="sidebar-footer"]').getByRole("button", { name: new RegExp(ADMIN.username) }).click()
  await page.getByRole("menuitem", { name: en.nav.user.language }).click()
  await page.getByRole("menuitem", { name: "Bahasa Indonesia" }).click()
  await expect(page.locator("html")).toHaveAttribute("lang", "id")

  // Rendered by the server in Indonesian: sidebar, header, page content.
  await expect(sidebar(page).getByRole("link", { name: id.nav.pages.containers, exact: true })).toBeVisible()
  await expect(sidebar(page).getByText(id.nav.groups.administration, { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { level: 1, name: id.nav.pages.dashboard })).toBeVisible()

  // The first HTML the server sends is already Indonesian (no flash of English).
  const html = await (await page.request.get("/users")).text()
  expect(html).toContain(`>${id.nav.pages.users}<`)
  expect(html).not.toContain(`>${en.nav.groups.administration}<`)

  await page.goto("/containers")
  await expect(page.getByRole("heading", { level: 1, name: id.nav.pages.containers, exact: true })).toBeVisible()
  await expect(page.getByPlaceholder(id.common.table.searchPlaceholder).first()).toBeVisible()
  await expect(page.getByText(new RegExp(`^${id.common.table.rowsPerPage}$`))).toBeVisible()

  for (const path of ["/notifications", "/backups", "/users", "/stacks", "/images", "/volumes", "/networks"]) {
    await page.goto(path)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    // No English table chrome left on the page.
    await expect(page.getByText(en.common.table.rowsPerPage, { exact: true })).toHaveCount(0)
  }

  // The sign-in screen follows the cookie too.
  const anonymous = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL })
  await anonymous.addCookies([{ name: "gantry-locale", value: "id", url: test.info().project.use.baseURL! }])
  const login = await anonymous.newPage()
  await login.goto("/login")
  await expect(login.locator("html")).toHaveAttribute("lang", "id")
  await expect(login.getByRole("button", { name: id.auth.login.submit, exact: true })).toBeVisible()
  await anonymous.close()

  // Back to English from the Account page.
  await page.goto("/account")
  await page.getByTestId("language-select").first().click()
  await page.getByRole("option", { name: "English" }).click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page.getByRole("heading", { level: 1, name: en.nav.pages.account })).toBeVisible()
  await expect(sidebar(page).getByRole("link", { name: en.nav.pages.containers, exact: true })).toBeVisible()
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    test.skip(!(await dockerAvailable()), "Docker socket not available")
    await removeContainer(CONTAINER)
    await startScratchContainer(CONTAINER)
  })

  test.afterAll(async () => {
    await removeContainer(CONTAINER)
  })

  async function expectNoHorizontalOverflow(page: Page, name: string) {
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    expect(scrollWidth, `${name} overflows horizontally`).toBeLessThanOrEqual(innerWidth)
  }

  async function expectInViewport(page: Page, locator: ReturnType<Page["locator"]>) {
    const box = (await locator.boundingBox())!
    const viewport = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  }

  test("main pages fit the screen", async ({ page }) => {
    test.setTimeout(300_000)
    await signIn(page)
    const pages = [
      "/dashboard",
      "/containers",
      "/images",
      "/volumes",
      "/networks",
      "/stacks",
      "/stacks/new",
      "/templates",
      "/topology",
      "/registries",
      "/notifications",
      "/auto-update",
      "/proxy",
      "/environments",
      "/users",
      "/activity",
      "/backups",
      "/account",
    ]
    for (const path of pages) {
      await page.goto(path)
      await expect(page.locator("[data-route-loading]")).toHaveCount(0)
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
      await expectNoHorizontalOverflow(page, path)
      if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/gantry-mobile${path.replaceAll("/", "-")}.png` })
    }

    // Container detail (info, logs, console tabs).
    await page.goto("/containers")
    await page.getByRole("link", { name: CONTAINER, exact: true }).click()
    await expect(page).toHaveURL(/\/containers\/[0-9a-f]+/)
    await expect(page.getByRole("heading", { name: CONTAINER })).toBeVisible()
    await expectNoHorizontalOverflow(page, "container detail")
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/gantry-mobile-container.png`, fullPage: true })
    for (const tab of ["Logs", "Console"]) {
      await page.getByRole("tab", { name: tab }).click()
      await expectNoHorizontalOverflow(page, `container ${tab}`)
      if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/gantry-mobile-container-${tab.toLowerCase()}.png` })
    }
  })

  test("sidebar sheet, row actions and dialogs work", async ({ page }) => {
    await signIn(page)

    // The sidebar is a sheet behind the header button; picking a page closes it.
    await page.getByRole("button", { name: en.nav.sidebar.toggle }).click()
    const sheet = page.getByRole("dialog", { name: en.nav.sidebar.title })
    await expect(sheet).toBeVisible()
    await expectInViewport(page, sheet)
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/gantry-mobile-sidebar.png` })
    await sheet.getByRole("link", { name: en.nav.pages.containers, exact: true }).click()
    await expect(page).toHaveURL(/\/containers$/)
    await expect(sheet).toBeHidden()

    // Row actions stay reachable at the right edge, even though the table scrolls sideways.
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: CONTAINER, exact: true }) })
    const menuButton = row.getByRole("button", { name: "Open menu" })
    await expect(menuButton).toBeVisible()
    await expectInViewport(page, menuButton)
    const target = (await menuButton.boundingBox())!
    expect(target.height).toBeGreaterThanOrEqual(36)
    await menuButton.click()
    await page.getByRole("menuitem", { name: "Remove" }).click()
    const confirm = page.getByRole("alertdialog", { name: `Remove ${CONTAINER}?` })
    await expect(confirm).toBeVisible()
    await expectInViewport(page, confirm)
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/gantry-mobile-confirm.png` })
    await confirm.getByRole("button", { name: "Cancel" }).click()
    await expect(confirm).toBeHidden()

    // A form dialog fits the screen and scrolls inside itself.
    await page.getByRole("button", { name: "Create container" }).click()
    const dialog = page.getByRole("dialog", { name: "Create container" })
    await expect(dialog).toBeVisible()
    await expectInViewport(page, dialog)
    await expectNoHorizontalOverflow(page, "create container dialog")
    if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/gantry-mobile-dialog.png` })
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden()
  })
})
