# Ram Browser Icons

## Required icon files for distribution builds

- `icon.icns` — macOS (multi-size icns, required for .dmg)
- `icon.ico` — Windows (multi-size ico, required for NSIS installer)
- `256x256.png`, `512x512.png` — Linux (AppImage, deb)

## Generating from the SVG source

Use `icon.svg` (512×512) as the master source.

### macOS (icns)
```bash
# Requires Xcode command line tools
mkdir -p icon.iconset
for size in 16 32 64 128 256 512; do
  rsvg-convert -w $size -h $size icon.svg > icon.iconset/icon_${size}x${size}.png
  rsvg-convert -w $((size*2)) -h $((size*2)) icon.svg > icon.iconset/icon_${size}x${size}@2x.png
done
iconutil -c icns icon.iconset -o icon.icns
```

### Windows (ico)
```bash
# Requires ImageMagick
magick icon.svg -resize 256x256 icon.ico
# Or for multi-size ico:
magick icon.svg \( -clone 0 -resize 16x16 \) \( -clone 0 -resize 32x32 \) \
  \( -clone 0 -resize 48x48 \) \( -clone 0 -resize 64x64 \) \
  \( -clone 0 -resize 128x128 \) \( -clone 0 -resize 256x256 \) \
  -delete 0 icon.ico
```

### Linux (PNG)
```bash
rsvg-convert -w 256 -h 256 icon.svg > 256x256.png
rsvg-convert -w 512 -h 512 icon.svg > 512x512.png
```

## Placeholder icons
Until proper icons are generated, electron-builder will use its default icon.
Place the generated files in this directory (`build/icons/`) before running `npm run dist`.
