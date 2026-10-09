# Zen identity

Original ensō brush mark generated for Zen from a written design brief, inspired by the general brush-circle direction supplied by the user. The stock reference image is not included or traced.

- `enso-master.png`: transparent original mark.
- `app-icon.png`: matching warm ivory macOS tile.
- `zen.icns`: packaged macOS icon, including Retina sizes.
- `../../extension/media/zen-mark.png`: 128px alpha mask used by the header in either theme.

Run `node scripts/build-branding.mjs` on macOS to regenerate sized outputs from the checked-in masters. The image-generation service is not a runtime dependency. Maintained runtime/source overlay scripts install these assets; the launcher signs only after resource updates.
