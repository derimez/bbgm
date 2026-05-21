#!/usr/bin/env bash
# Pull the 30 Emirates NBA Cup 2025 court images from nba.com and save them
# into server/public/courts/ as cup_{city_team}.jpg, e.g.:
#   cup_new_york_knicks.jpg
#   cup_los_angeles_lakers.jpg
#
# Source page (kept here for traceability — actual URLs are hard-coded below
# because the page lists predictable cdn.nba.com paths per team):
#   https://www.nba.com/news/emirates-nba-cup-2025-courts-unveiled
#
# Images live at:
#   https://cdn.nba.com/manage/2025/10/NBA-Cup-Court_NNNN_{abbr}-scaled.png
# (-scaled is the 2560-wide variant; the page also offers smaller sizes.)
#
# Source PNGs are converted to JPEG (q=92) to match the existing courts/*.jpg
# naming convention.
#
# Usage:
#   bash scripts/fetch-nba-cup-courts.sh
#
# Behaviour:
#   - Resumable: existing cup_*.jpg files are skipped
#   - 0.3s pause between downloads
#   - Per-team failures don't abort the run

set -uo pipefail

OUT_DIR="server/public/courts"
DELAY_SEC="${DELAY_SEC:-0.3}"
# cdn.nba.com 403/HTTP-2-resets a non-browser UA on these asset paths.
USER_AGENT="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
REFERER="https://www.nba.com/news/emirates-nba-cup-2025-courts-unveiled"
CDN_BASE="https://cdn.nba.com/manage/2025/10"

mkdir -p "$OUT_DIR"

if ! command -v convert >/dev/null; then
  echo "ERROR: ImageMagick 'convert' not found — needed to convert PNG → JPG" >&2
  exit 1
fi

# index:abbr:city_team (index matches the source URL's NNNN; city_team is
# the filename slug we want)
TEAMS=(
  "0000:atl:atlanta_hawks"
  "0001:bkn:brooklyn_nets"
  "0002:bos:boston_celtics"
  "0003:cha:charlotte_hornets"
  "0004:chi:chicago_bulls"
  "0005:cle:cleveland_cavaliers"
  "0006:dal:dallas_mavericks"
  "0007:den:denver_nuggets"
  "0008:det:detroit_pistons"
  "0009:gsw:golden_state_warriors"
  "0010:hou:houston_rockets"
  "0011:ind:indiana_pacers"
  "0012:lac:los_angeles_clippers"
  "0013:lal:los_angeles_lakers"
  "0014:mem:memphis_grizzlies"
  "0015:mia:miami_heat"
  "0016:mil:milwaukee_bucks"
  "0017:min:minnesota_timberwolves"
  "0018:nop:new_orleans_pelicans"
  "0019:nyk:new_york_knicks"
  "0020:okc:oklahoma_city_thunder"
  "0021:orl:orlando_magic"
  "0022:phi:philadelphia_76ers"
  "0023:phx:phoenix_suns"
  "0024:por:portland_trail_blazers"
  "0025:sac:sacramento_kings"
  "0026:sas:san_antonio_spurs"
  "0027:tor:toronto_raptors"
  "0028:uta:utah_jazz"
  "0029:was:washington_wizards"
)

total_downloaded=0
total_skipped=0
total_failed=0

for row in "${TEAMS[@]}"; do
  IFS=":" read -r idx abbr city_team <<<"$row"

  slug="cup_${city_team}"
  dest="$OUT_DIR/${slug}.jpg"

  if [ -f "$dest" ]; then
    total_skipped=$((total_skipped + 1))
    continue
  fi

  url="${CDN_BASE}/NBA-Cup-Court_${idx}_${abbr}-scaled.png"
  tmp_png="$OUT_DIR/${slug}.png.tmp"

  if curl -fsS --http1.1 -A "$USER_AGENT" -e "$REFERER" -H "Accept: image/png,image/*,*/*" -o "$tmp_png" "$url"; then
    if convert "$tmp_png" -quality 92 "$dest"; then
      rm -f "$tmp_png"
      total_downloaded=$((total_downloaded + 1))
      printf '    [ok %2d] %s\n' "$total_downloaded" "${slug}.jpg"
    else
      rm -f "$tmp_png" "$dest"
      total_failed=$((total_failed + 1))
      printf '    [convert-fail] %s\n' "$slug"
    fi
  else
    rm -f "$tmp_png"
    total_failed=$((total_failed + 1))
    printf '    [dl-fail] %s (%s)\n' "$slug" "$url"
  fi

  sleep "$DELAY_SEC"
done

echo
echo "Done."
echo "  downloaded: $total_downloaded"
echo "  skipped (already present): $total_skipped"
echo "  failed: $total_failed"
echo
echo "Images are in $OUT_DIR as cup_{city_team}.jpg"
