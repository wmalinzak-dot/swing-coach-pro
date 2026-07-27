# Rewind Royale

A battle royale where eliminated players don't leave the match — they rewind
60 seconds into the past and come back as **echoes**: translucent ghosts who
can't fight, but can open doors, flip switches, and move loot to tilt the
present-timeline fight.

This folder is the game's source of truth. Code lives here in git and syncs
into Roblox Studio with [Rojo](https://rojo.space).

## How to get this onto Roblox

### 0. One-time account setup
1. Create a Roblox account at https://www.roblox.com (free).
2. Download **Roblox Studio** from https://create.roblox.com — it's the only
   way to publish experiences. Windows and macOS only.

### 1. Recommended workflow: Rojo (code stays in git)
Rojo watches this folder and live-syncs scripts into an open Studio place.

```bash
# install the Rojo CLI (via Aftman/Rokit, or download a release binary)
# https://rojo.space/docs/v7/getting-started/installation/

cd roblox/rewind-royale
rojo serve
```

Then in Studio:
1. Install the Rojo plugin (Studio → Toolbox, or from the Rojo docs).
2. Open a new Baseplate place.
3. Click the Rojo plugin → **Connect** (defaults to localhost:34872).
4. Scripts from `src/` appear under `ServerScriptService`,
   `ReplicatedStorage`, and `StarterPlayerScripts` per `default.project.json`.

Edit code here in your editor; Studio updates instantly. The map itself
(terrain, buildings, spawn points) is built visually in Studio — Rojo only
manages code.

### 2. Simple workflow: paste into Studio (no tooling)
If you don't want Rojo yet: open Studio, create a Baseplate, and copy each
file's contents into a Script/ModuleScript/LocalScript in the location listed
at the top of that file. Fine for a first prototype; you'll outgrow it.

### 3. Publishing
1. In Studio: **File → Publish to Roblox As...** → create a new experience.
2. It's published **private** by default. Playtest it yourself (Studio's
   Play button, or the Roblox app on your phone once published).
3. When ready: Creator Dashboard (https://create.roblox.com/dashboard) →
   your experience → **Make Public**.
4. Fill in the game page: icon (512×512), thumbnails, description, genre.
   These matter — Roblox's discovery algorithm and player click-through
   depend heavily on them.

### 4. Monetization (once it's fun)
- **Game passes** (Creator Dashboard → Monetization): e.g. exclusive echo
  cosmetics, "Echo+" with extra map interactions.
- **Developer products**: consumables like bonus rewind charges.
- **Premium payouts** accrue automatically from Premium subscribers' playtime.
- Cash out via DevEx once you hit 30,000 earned Robux.

Rule of thumb for this game: sell **cosmetics and convenience, never combat
power** — pay-to-win kills battle royales.

## Game design (v0 scope)

**Core loop:** Lobby → countdown → battle royale on a small map → eliminated
players become echoes at their own position from 60s ago → last survivor wins
→ everyone earns XP (survivors more, echoes some for interactions).

**The hook — elimination is a role change, not a game over:**
- `RewindService` records a snapshot of every player (position, time) at
  10 Hz into a 60-second ring buffer.
- On elimination, the player respawns **where they were 60 seconds ago**,
  translucent, weaponless, and invisible to no one — survivors see ghosts
  moving through the world.
- Echoes can trigger `EchoInteractable`-tagged parts (doors, bridges, loot
  drops) with a cooldown. They can help or grief — that's the drama.

**v0 deliberately cuts:** full past-world simulation (echoes replaying in a
real time layer), weapons variety, squads. Ship the ghost-interaction
version first; if it's fun, the true time-layer version is the sequel
mechanic.

## File map

| File | Runs in | Purpose |
|---|---|---|
| `src/shared/Config.luau` | ReplicatedStorage | All tuning knobs |
| `src/server/GameLoop.server.luau` | ServerScriptService | Boots services |
| `src/server/MatchService.luau` | ServerScriptService | Lobby/match state machine |
| `src/server/RewindService.luau` | ServerScriptService | Snapshot ring buffer + echo conversion |
| `src/server/EchoInteract.luau` | ServerScriptService | Echo ↔ map interactions |
| `src/client/EchoOverlay.client.luau` | StarterPlayerScripts | Screen tint + UI when you're an echo |
