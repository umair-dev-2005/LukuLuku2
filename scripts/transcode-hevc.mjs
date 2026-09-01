#!/usr/bin/env node
/**
 * Server-side HEVC -> H.264 transcode for LukuLuku videos.
 *
 * Some clips (iPhone .mov) are HEVC/hvc1, which the in-app player (ExoPlayer/expo-video)
 * struggles with while the web (browser) plays them fine. This script finds HEVC videos in
 * Supabase storage and re-encodes them to H.264 (same container, faststart), uploading the
 * result back to the SAME storage path. Because the path is unchanged, no database rows
 * need updating — video_url stays valid and the clips just start playing in the app.
 *
 * Requirements:
 *   - ffmpeg + ffprobe on PATH
 *   - env SUPABASE_SERVICE_ROLE_KEY  (service role — needed to overwrite storage; keep it secret)
 *   - npm dep @supabase/supabase-js (already in this project)
 *
 * Usage:
 *   SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/transcode-hevc.mjs            # dry run (detect only)
 *   SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/transcode-hevc.mjs --apply    # actually transcode + upload
 */
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUPABASE_URL = 'https://ymmgctotppvzuczrhdgc.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APPLY = process.argv.includes('--apply');
const BUCKET = 'videos';

if (!SERVICE_KEY) {
  console.error('❌ Set SUPABASE_SERVICE_ROLE_KEY env var (Supabase dashboard → Project Settings → API → service_role).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Pull every video_url referenced by the videos + shorts tables.
async function collectVideoUrls() {
  const urls = new Set();
  for (const table of ['videos', 'shorts']) {
    const { data, error } = await supabase.from(table).select('video_url');
    if (error) { console.warn(`warn: could not read ${table}: ${error.message}`); continue; }
    for (const row of data || []) if (row.video_url) urls.add(row.video_url.trim());
  }
  return [...urls];
}

// videos bucket public URL -> storage path inside the bucket
function urlToPath(url) {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const i = url.indexOf(marker);
  return i < 0 ? null : decodeURIComponent(url.slice(i + marker.length));
}

// Probe the codec straight from the URL (ffprobe range-reads — no full download needed).
function probeCodec(urlOrFile) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=nk=1:nw=1', urlOrFile,
    ]).toString().trim();
    return out;
  } catch { return ''; }
}

async function main() {
  const urls = await collectVideoUrls();
  console.log(`Found ${urls.length} unique video URLs. Mode: ${APPLY ? 'APPLY (will overwrite)' : 'DRY RUN'}\n`);
  const work = tmpdir() && mkdtempSync(join(tmpdir(), 'luku-tx-'));
  let hevc = 0, done = 0, failed = 0;

  for (const url of urls) {
    const path = urlToPath(url);
    if (!path) continue;

    // Detect codec directly from the URL — only HEVC clips get downloaded + transcoded.
    const codec = probeCodec(url);
    if (codec !== 'hevc' && codec !== 'h265') continue;
    hevc++;
    console.log(`HEVC: ${path}`);
    if (!APPLY) continue;

    const local = join(work, 'in' + (path.endsWith('.mov') ? '.mov' : '.mp4'));
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`  skip (HTTP ${res.status})`); continue; }
      writeFileSync(local, Buffer.from(await res.arrayBuffer()));
    } catch (e) { console.warn(`  skip (download): ${e.message}`); continue; }

    const outFile = join(work, 'out.mp4');
    try {
      execFileSync('ffmpeg', [
        '-y', '-i', local,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        outFile,
      ], { stdio: 'ignore' });
      const buf = readFileSync(outFile);
      const { error } = await supabase.storage.from(BUCKET).upload(path, buf, {
        upsert: true, contentType: 'video/mp4',
      });
      if (error) throw new Error(error.message);
      console.log(`  ✅ transcoded + uploaded (${(buf.length / 1048576).toFixed(1)} MB) -> ${path}`);
      done++;
    } catch (e) { console.error(`  ❌ failed: ${path} — ${e.message}`); failed++; }
  }

  rmSync(work, { recursive: true, force: true });
  console.log(`\nDone. HEVC found: ${hevc}, transcoded: ${done}, failed: ${failed}.`);
  if (!APPLY && hevc > 0) console.log('Re-run with --apply to transcode and overwrite these.');
}

main().catch((e) => { console.error(e); process.exit(1); });
