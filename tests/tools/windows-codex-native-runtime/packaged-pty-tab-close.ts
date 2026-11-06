import { delay, type SessionHandle } from './packaged-pty-app-support'

export async function clickCloseTab(
  page: SessionHandle['page'],
  tabId: string,
  expectPrompt: boolean
): Promise<void> {
  const tab = page.locator(
    `[data-testid="sortable-tab"][data-tab-id=${JSON.stringify(tabId)}]:visible`
  )
  const prompt = page.getByRole('dialog', {
    name: /^(Stop running command|Stop this agent)\?$/
  })
  const confirm = prompt.getByRole('button', { name: /^(Stop and Close|Stop Agent)$/ })
  if ((await page.getByRole('dialog').count()) > 0) {
    throw new Error('A dialog was already open before closing the packaged terminal tab')
  }
  await tab.getByRole('button', { name: /^Close tab /i }).click()
  if (expectPrompt) {
    await prompt.waitFor({ state: 'visible', timeout: 15_000 })
    await confirm.click()
    await tab.waitFor({ state: 'hidden', timeout: 20_000 })
    return
  }

  const deadline = Date.now() + 20_000
  let confirmed = false
  while (Date.now() < deadline) {
    if (!(await tab.isVisible())) {
      return
    }
    // The running-work probe may request confirmation even after the shell returns.
    if (!confirmed && (await prompt.isVisible())) {
      await confirm.click({ timeout: Math.max(1, deadline - Date.now()) })
      confirmed = true
    }
    await delay(100)
  }
  throw new Error(
    'The packaged terminal tab did not close ' +
      `(confirmed=${confirmed}; knownPromptVisible=${await prompt.isVisible()})`
  )
}
