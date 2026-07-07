/**
 * Annotation + epic-memory tooling install.
 *
 * The implementation now lives in `@aidlc/core` (`presets/annotationTools`) so
 * the extension and CLI share it. This is a thin re-export shim kept so the
 * extension's existing import site (`./annotationToolsInstaller`) keeps working.
 *
 * The extension passes its own `extensionPath` as the bundle root — its build
 * copies `tools/` + `vendor/annotron` in (copy:tools / copy:annotron) and
 * `assets/` is committed, so all the payload is present there.
 */
export { installAnnotationTools } from '@aidlc/core';
