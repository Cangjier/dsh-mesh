/**
 * Compatibility entry point for the CDP session used by the account sign-in
 * helper. The implementation lives in `code/shared` so the build-time smoke
 * test can reuse it from a packaged plugin as well.
 *
 * @module dsh-mesh/gate/chrome
 */

export { ChromeSession } from '../shared/chrome.mjs'
