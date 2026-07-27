-- ModuleScript → ReplicatedStorage/Shared/Config
-- Every tuning knob for Rewind Royale lives here.

return {
	-- Rewind mechanic
	REWIND_SECONDS = 60, -- how far back an eliminated player is sent
	SNAPSHOT_HZ = 10, -- position samples per second per player

	-- Match flow
	MIN_PLAYERS = 2,
	LOBBY_COUNTDOWN = 15, -- seconds once MIN_PLAYERS is reached
	MATCH_MAX_SECONDS = 300, -- hard cap; most survivors alive wins on timeout

	-- Echoes
	ECHO_TRANSPARENCY = 0.6,
	ECHO_WALKSPEED = 20, -- slightly faster than default 16: dead but nimble
	ECHO_INTERACT_COOLDOWN = 8, -- seconds between map interactions per echo
	ECHO_INTERACT_TAG = "EchoInteractable", -- CollectionService tag on parts

	-- Rewards (hook these to XP/currency later)
	XP_WIN = 100,
	XP_SURVIVAL_PER_MINUTE = 10,
	XP_ECHO_INTERACTION = 5,
}
