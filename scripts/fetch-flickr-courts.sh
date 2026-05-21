#!/usr/bin/env bash
# Pull the kodrinsky NBA-courts Flickr album (1,448 photos as of 2026-05-15)
# into server/public/courts/, named by the photo's Flickr title.
#
# Title format examples (kodrinsky's convention):
#   "Madison Square Garden IV (1998/2000)" → first season 1998-99, last 1999-00
#   "Madison Square Garden IV (2000)"      → single year, usually an alternate
#   "Smoothie King Center (All-Star Game, 2014)" → event/year
# We slugify the title verbatim and use it as the filename, so the year
# range stays parseable downstream.
#
# Naming: lowercase, all non-alnum → underscore, collapsed:
#   "Madison Square Garden IV (1998/2000)"  → madison_square_garden_iv_1998_2000.jpg
#   "Madison Square Garden IV (2000)"       → madison_square_garden_iv_2000.jpg
#   "Smoothie King Center (All-Star Game, 2014)" → smoothie_king_center_all_star_game_2014.jpg
# Duplicate slugs get __2, __3 suffixes.
#
# Usage:
#   bash scripts/fetch-flickr-courts.sh
#
# Behaviour:
#   - Resumable: if slug file already exists, skip
#   - Migration: if a legacy {photo_id}_{secret}_h.jpg exists from an earlier
#     run, rename it in place instead of re-downloading
#   - 0.3s pause between *new* downloads (renames are free)
#   - Per-image failures don't abort the run
#
# YOU are running this script under YOUR user account. Whatever licence
# terms apply to those photos apply to your saved copies — check before you
# redistribute.

set -uo pipefail

ALBUM_ID="72157632177646900"
USER_NSID="8179152@N02"
ALBUM_URL="https://www.flickr.com/photos/${USER_NSID}/albums/${ALBUM_ID}"
OUT_DIR="server/public/courts"
DELAY_SEC="${DELAY_SEC:-0.3}"
USER_AGENT="Mozilla/5.0 (compatible; bbgm-simcast-fetch/1.0)"
PER_PAGE="${PER_PAGE:-500}"

mkdir -p "$OUT_DIR"

echo "Extracting public API key from album page..."
api_key=$(curl -fsS -A "$USER_AGENT" "$ALBUM_URL" \
  | grep -oE 'site_key = "[a-f0-9]+"' \
  | head -1 \
  | sed -E 's/site_key = "(.+)"/\1/')

if [ -z "$api_key" ]; then
  echo "ERROR: could not extract Flickr site_key from album page" >&2
  exit 1
fi
echo "  api_key: ${api_key:0:8}..."

# Walk all pages, write one tab-separated row per photo:
#   {photo_id}\t{secret}\t{server}\t{slug}\t{url}
api_pages_total=$(curl -fsS -A "$USER_AGENT" \
  "https://api.flickr.com/services/rest/?method=flickr.photosets.getPhotos&api_key=${api_key}&photoset_id=${ALBUM_ID}&user_id=${USER_NSID}&per_page=${PER_PAGE}&page=1&format=json&nojsoncallback=1&extras=url_h,url_k,url_b,url_c" \
  | jq -r '.photoset.pages')

manifest_tmp=$(mktemp)
slug_seen_tmp=$(mktemp)
trap 'rm -f "$manifest_tmp" "$slug_seen_tmp"' EXIT

echo "Album has $api_pages_total API page(s); building manifest..."

for page in $(seq 1 "$api_pages_total"); do
  page_json=$(curl -fsS -A "$USER_AGENT" \
    "https://api.flickr.com/services/rest/?method=flickr.photosets.getPhotos&api_key=${api_key}&photoset_id=${ALBUM_ID}&user_id=${USER_NSID}&per_page=${PER_PAGE}&page=${page}&format=json&nojsoncallback=1&extras=url_h,url_k,url_b,url_c")

  # For each photo: id, secret, title, best-available URL.
  # Then derive slug from title in jq (lowercase + non-alnum → _, trim).
  printf '%s' "$page_json" | jq -r '
    .photoset.photo[]
    | select((.url_h // .url_k // .url_b // .url_c // "") != "")
    | [
        .id,
        .secret,
        ((.title | ascii_downcase
                 | gsub("&"; " and ")
                 | gsub("[^a-z0-9]+"; "_")
                 | gsub("^_+|_+$"; ""))
         // "untitled"),
        (.url_h // .url_k // .url_b // .url_c)
      ]
    | @tsv
  ' >> "$manifest_tmp"
done

total_rows=$(wc -l < "$manifest_tmp")
echo "Manifest built: $total_rows photo(s) with downloadable image"

total_renamed=0
total_downloaded=0
total_skipped=0
total_failed=0

while IFS=$'\t' read -r photo_id secret slug url; do
  [ -z "$photo_id" ] && continue

  # Slug collision: if we've used this base slug already in this run, append __N
  base_slug="$slug"
  n=1
  while grep -qxF "$slug" "$slug_seen_tmp" 2>/dev/null; do
    n=$((n + 1))
    slug="${base_slug}__${n}"
  done
  echo "$slug" >> "$slug_seen_tmp"

  dest="$OUT_DIR/${slug}.jpg"

  if [ -f "$dest" ]; then
    total_skipped=$((total_skipped + 1))
    continue
  fi

  # Migration: any legacy {photo_id}_{secret}_h.jpg already on disk?
  legacy=$(ls "$OUT_DIR"/${photo_id}_*.jpg 2>/dev/null | head -1)
  if [ -n "$legacy" ] && [ -f "$legacy" ]; then
    mv "$legacy" "$dest"
    total_renamed=$((total_renamed + 1))
    if [ $((total_renamed % 100)) -eq 0 ]; then
      printf '    [renamed %d] %s\n' "$total_renamed" "${slug}.jpg"
    fi
    continue
  fi

  if curl -fsS -A "$USER_AGENT" -o "$dest.tmp" "$url"; then
    mv "$dest.tmp" "$dest"
    total_downloaded=$((total_downloaded + 1))
    printf '    [dl %d] %s\n' "$total_downloaded" "${slug}.jpg"
  else
    rm -f "$dest.tmp"
    total_failed=$((total_failed + 1))
    printf '    [fail] %s (%s)\n' "$slug" "$url"
  fi

  sleep "$DELAY_SEC"
done < "$manifest_tmp"

echo
echo "Done."
echo "  renamed (from legacy {id}_*_h.jpg): $total_renamed"
echo "  downloaded (new):                   $total_downloaded"
echo "  skipped (slug already on disk):     $total_skipped"
echo "  failed:                             $total_failed"
echo
echo "Images are in $OUT_DIR named like: madison_square_garden_iv_1998_2000.jpg"
echo "Years in filename are 'first season start / last season end' per the album convention."
