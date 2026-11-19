# Mentat sync server

(Mentat was called Torn Desktop until 2026-11-18. File, service and path names such as `torn-desktop-server.service` keep the old name.)

Optional. By default Mentat collects and keeps everything on your PC. If you run this
server, it collects around the clock with its own copy of your Torn API key. Every PC you
connect then shows the same history and settings, even history from while your PCs were off.

**What it collects** (the same code as the app):

| Data | How |
|---|---|
| Oppo research | From the moment a ranked war is announced: enemy members' activity every 5 minutes, personal stats daily, track record |
| War history | Score and enemy availability through a ranked war, travel departures |
| Abroad stock | YATA every 2 minutes, for restock patterns |
| Prices | Torn market values every 6 hours, item market lows for your watched items, bazaar lows from Weav3r |
| Scouting | Every faction in your rank group and the groups either side that warred in the last 30 days: members' activity (15-minute slots, kept per player) checked in rotation, and their last 10 ranked war reports. The pool is rebuilt from Torn's rank ladder daily, so it follows factions moving up and down |
| War record | For a researched faction: its last 10 ranked war reports, the chain reports from those wars, members' wars in other factions, and momentum (personal-stat snapshots weekly back 10 weeks, and around each of its last 3 wars) |

**What it syncs:** targets, custom alerts, watched items, war pins, appearance, clocks,
popups, chain alerts, travel settings and your measured flight times. Keys, window positions
and the open tab stay on each PC.

## Requirements

- Node.js 20 or newer. No npm packages.
- A Torn API key with **Limited** access. A separate key just for the server is best.
- HTTPS if the server is reachable from outside your home network, for example through a
  reverse proxy such as Caddy or nginx, or a Cloudflare tunnel. The app refuses plain
  `http://` except for addresses on your home network.

## Set up

```sh
node server/server.js init      # asks for the Torn key (hidden), makes config.json and an access token
node server/server.js           # run it (listens on 127.0.0.1:8830)
```

In Mentat, open **Settings → Data source → Server**, enter the server address
(for example `https://example.com/torn-desktop`) and the access token, then **Connect**.
On the first PC, click **Send this PC's data** once to give the server what you've already
collected.

Other commands:

```sh
node server/server.js token      # show the access token again
node server/server.js set-key    # replace the Torn key (then restart)
node server/server.js --config /etc/torn-desktop/config.json   # use another config file
```

## config.json

```json
{
  "host": "127.0.0.1",
  "port": 8830,
  "dataDir": "data",
  "maxPerMinute": 30,
  "scoutPerMinute": 20,
  "activityKeepDays": 180,
  "tornKey": "…",
  "token": "…",
  "collect": { "research": true, "war": true, "travel": true, "prices": true, "bazaar": true, "scout": true }
}
```

- `maxPerMinute`: the server's own Torn API request limit. Torn allows 100 per minute per
  player across every key and tool, and each PC running Mentat uses up to its own
  limit (40 by default), so leave room.
- Secrets can live outside the file: `tornKeyFile` / `tokenFile` (paths), the environment
  variables `TD_TORN_KEY` / `TD_TOKEN`, or systemd credentials named `torn_key` and `token`
  (`LoadCredential=`). Other variables: `TD_CONFIG`, `TD_HOST`, `TD_PORT`, `TD_DATA_DIR`.
- `publicUrl`: the address people reach this server at (`https://mentat.example.com`). Phone
  alerts use it as their contact, and the Torn PDA script and its guide (`/pda/`) are served
  with it in place of `mentat.example.com`.
- `scoutPerMinute`: how many of those requests scouting may use (lowest priority, so research,
  war and the rest always go first). With 20, about 600 factions are checked every 30 minutes;
  the interval grows with the pool. `activityKeepDays`: how long activity history is kept.
- `dataDir` holds plain JSON files, `activity/` (one small binary file per day) and `wars/`
  (war and chain reports). Back up this folder.

## Cloud backup (optional)

The server can keep an off-site copy of its data folder in any S3-compatible storage:
Cloudflare R2 (10 GB free), Backblaze B2, AWS S3, Wasabi or MinIO. Every hour it packs the
folder into a `.tar.gz`, checks it unpacks, uploads it as
`<prefix>/torn-desktop-YYYYMMDD-HHMMSS.tar.gz`, and prunes: every copy from the last 48 hours
is kept, then the newest copy of each day for 30 days. Only files with that name pattern are
ever deleted. The data folder holds collected game data and synced app settings; the Torn key
and the access token are not in it.

```json
"cloudBackup": {
  "enabled": true,
  "endpoint": "https://<account id>.r2.cloudflarestorage.com",
  "bucket": "my-mentat-backups",
  "region": "auto",
  "prefix": "torn-desktop",
  "everyMinutes": 60, "hourlyHours": 48, "dailyDays": 30
}
```

- Use an access key limited to that one bucket (R2: **Manage R2 API Tokens → Object Read &
  Write**, applied to the bucket).
- The key ID and secret go in systemd credentials `s3_key_id` and `s3_secret`, the variables
  `TD_S3_KEY_ID` / `TD_S3_SECRET`, or files named by `keyIdFile` / `secretFile`.
  `endpoint` and `bucket` can also come from a separate JSON file (`"configFile"`) or
  `TD_S3_ENDPOINT` / `TD_S3_BUCKET`. Use `"region": "us-east-1"` (or your region) outside R2.
- The server logs `Cloud backup: connected to bucket …` at start-up, and the result of each
  upload. The status is also in `<dataDir>/cloud-backup.json` and the app's Data source panel.
- To restore: download a copy, stop the server, unpack it into an empty data folder
  (`tar -xzf torn-desktop-….tar.gz -C <dataDir>`), start the server.

## Faction members

Members of your faction can use Mentat with your server's data. In the app they enter their own
Torn API key on the welcome screen (with your server's address, or the one built into your copy
of the app in `mentat.local.json`, see the main README).

- The server asks Torn whose key it is and which faction they're in, then forgets the key. It is
  never stored or logged. The member gets a session token; the server keeps only its SHA-256 hash
  (`<dataDir>/members.json`). Sessions last 90 days from last use, at most 12 devices each.
- Let in: members of your faction, players on the allow-list, and admins. Every 30 minutes the
  faction's member list is checked with your key (one request); anyone who left is signed out.
- Members can read the shared data (oppo research, war records, scouting, abroad stock, prices)
  and keep their own settings (`<dataDir>/members/<player id>.json`). Only your access token can
  upload data or change what the server collects.
- Admins manage the allow-list in the app: Settings → Account → Members.
- `config.json` → `access`: `factionId` (default: your key's faction), `adminIds` (default: your
  key's player; add officers' player IDs here).
- For members to reach it, the server needs a public HTTPS address that doesn't sit behind another
  login (for example its own hostname through a Cloudflare tunnel, with Access set to Bypass for
  it). Sign-ins are limited to 10 tries per address and 60 in total per 10 minutes.

## Behind a reverse proxy

The server answers under any path prefix, so either of these works:

```
# Caddy
example.com {
  handle_path /torn-desktop/* {
    reverse_proxy 127.0.0.1:8830
  }
}
```

If the proxy is protected by Cloudflare Access, create a **service token** and a
**Service Auth** policy for the path, then enter the token's client ID and secret under
"Behind Cloudflare Access?" in the app. The access token is still required.

## Run as a service (systemd)

See `torn-desktop-server.service`. Copy the app folder to `/opt/torn-desktop`, put the config
in `/etc/torn-desktop/config.json` without any secrets, and the key and token in root-only
files that systemd passes in with `LoadCredential=`. Build the folder with
`node scripts/pack-server.js` (output: `dist/torn-desktop-server/`).

## API

All routes need `Authorization: Bearer <token>` except `GET /api/v1/health`.

| Route | |
|---|---|
| `GET /api/v1/status` | what the server is collecting, data revisions |
| `GET /api/v1/data/{research,war,travel,prices,bazaar}` | a data set (gzip, ETag) |
| `POST /api/v1/data/{set}` | merge a client's data into the server's |
| `GET /api/v1/settings?since=REV` | synced settings changed after REV |
| `PUT /api/v1/settings` | `{ "units": { "targets.list": … } }` |

Only the official Torn API, YATA and Weav3r are contacted, the same as the app.
