/**
 * The package version, used by the packaged runtime descriptor and the startup log.
 *
 * This constant is deliberately plain rather than a `package.json` import: the supervisor bundle is loaded from an installed
 * `lib/` where a relative JSON import would resolve differently, and a runtime bundle must not reach outside itself. The
 * supervisor specification pins it to `package.json`, so a release that forgets to update both fails the test suite.
 */
export const VERSION = '0.4.0'
