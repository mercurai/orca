import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { MACOS_FOLDER_USAGE_DESCRIPTIONS } = require('./macos-folder-usage-descriptions.cjs')
const config = require('../electron-builder.config.cjs')

it('gives the app the same three folder descriptions as the terminal host helper', () => {
  expect(config.mac.extendInfo).toMatchObject(MACOS_FOLDER_USAGE_DESCRIPTIONS)
  expect(Object.keys(MACOS_FOLDER_USAGE_DESCRIPTIONS)).toHaveLength(3)
})
