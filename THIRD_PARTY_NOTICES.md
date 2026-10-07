# Third-party components

Zen's own source is provided under the MIT license in LICENSE. The app retains the Pair Code internal identifiers during this early development phase.

Code-OSS and VSCodium are separately maintained upstream projects. Bootstrap downloads the runtime and editor extensions listed in upstream.lock.json; their bundled licenses and notices must remain intact. npm dependencies retain their respective license files in installed packages. Packaging copies native Turso and Tree-sitter assets with their package notices.

This repository distributes project source and patch scripts, not a signed production editor. A distributable app needs a review of all bundled dependency and extension licenses, trademarks, signing and update behavior. Do not imply that the project's MIT license replaces third-party terms.
