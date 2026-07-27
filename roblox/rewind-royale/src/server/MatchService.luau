-- ModuleScript → ServerScriptService/Server/MatchService
-- Lobby → countdown → match → winner state machine.
-- A player who dies during a match becomes an echo instead of leaving.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.Shared.Config)
local RewindService = require(script.Parent.RewindService)

local MatchService = {}

type MatchState = "Lobby" | "Countdown" | "InMatch"
local state: MatchState = "Lobby"
local alive: { [Player]: boolean } = {}

-- Broadcast simple state strings for the client UI ("Lobby", "Countdown:12",
-- "Alive:5", "Winner:PlayerName").
local statusRemote = Instance.new("RemoteEvent")
statusRemote.Name = "MatchStatus"
statusRemote.Parent = ReplicatedStorage

local function broadcast(message: string)
	statusRemote:FireAllClients(message)
end

local function aliveCount(): number
	local n = 0
	for _, isAlive in alive do
		if isAlive then
			n += 1
		end
	end
	return n
end

local function lastSurvivor(): Player?
	for player, isAlive in alive do
		if isAlive then
			return player
		end
	end
	return nil
end

local function eliminate(player: Player)
	if state ~= "InMatch" or not alive[player] then
		return
	end
	alive[player] = false
	RewindService.becomeEcho(player)
	broadcast(`Alive:{aliveCount()}`)
end

local function watchCharacter(player: Player)
	player.CharacterAdded:Connect(function(character)
		local humanoid = character:WaitForChild("Humanoid", 5)
		if humanoid then
			humanoid.Died:Connect(function()
				-- Echoes that die just respawn as echoes again.
				if RewindService.isEcho(player) then
					task.wait(2)
					RewindService.becomeEcho(player)
				else
					eliminate(player)
				end
			end)
		end
	end)
end

local function endMatch(winner: Player?)
	state = "Lobby"
	broadcast(winner and `Winner:{winner.Name}` or "Winner:Nobody")
	task.wait(5)
	RewindService.resetAll()
	table.clear(alive)
	for _, player in Players:GetPlayers() do
		player:LoadCharacter()
	end
	broadcast("Lobby")
end

local function runMatch()
	state = "InMatch"
	table.clear(alive)
	for _, player in Players:GetPlayers() do
		alive[player] = true
		player:LoadCharacter()
	end
	broadcast(`Alive:{aliveCount()}`)

	local startedAt = os.clock()
	while state == "InMatch" do
		task.wait(1)
		local remaining = aliveCount()
		if remaining <= 1 then
			endMatch(lastSurvivor())
			return
		end
		if os.clock() - startedAt > Config.MATCH_MAX_SECONDS then
			-- Timeout: no single winner in v0; call it a draw.
			endMatch(nil)
			return
		end
	end
end

local function lobbyLoop()
	while true do
		task.wait(1)
		if state == "Lobby" and #Players:GetPlayers() >= Config.MIN_PLAYERS then
			state = "Countdown"
			for i = Config.LOBBY_COUNTDOWN, 1, -1 do
				broadcast(`Countdown:{i}`)
				task.wait(1)
				if #Players:GetPlayers() < Config.MIN_PLAYERS then
					state = "Lobby"
					broadcast("Lobby")
					break
				end
			end
			if state == "Countdown" then
				runMatch()
			end
		end
	end
end

function MatchService.init()
	for _, player in Players:GetPlayers() do
		watchCharacter(player)
	end
	Players.PlayerAdded:Connect(function(player)
		watchCharacter(player)
		-- Joining mid-match makes you an echo immediately: you can scout
		-- and interact, and you'll be a full combatant next round.
		if state == "InMatch" then
			alive[player] = false
			player.CharacterAdded:Wait()
			RewindService.becomeEcho(player)
		end
	end)
	Players.PlayerRemoving:Connect(function(player)
		alive[player] = nil
	end)
	task.spawn(lobbyLoop)
end

return MatchService
