-- ModuleScript → ServerScriptService/Server/RewindService
-- Records a rolling 60-second position history for every living player,
-- and converts eliminated players into echoes spawned at their own
-- position from REWIND_SECONDS ago.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.Shared.Config)

local RewindService = {}

-- Ring buffer per player: { {t = clockTime, cframe = CFrame}, ... }
local histories: { [Player]: { { t: number, cframe: CFrame } } } = {}
local echoes: { [Player]: boolean } = {}

local BUFFER_SIZE = Config.REWIND_SECONDS * Config.SNAPSHOT_HZ

-- Fired to the client when their echo state changes (true = became echo)
local echoStateRemote = Instance.new("RemoteEvent")
echoStateRemote.Name = "EchoStateChanged"
echoStateRemote.Parent = ReplicatedStorage

local function snapshot(player: Player)
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not root then
		return
	end
	local history = histories[player]
	if not history then
		history = {}
		histories[player] = history
	end
	table.insert(history, { t = os.clock(), cframe = root.CFrame })
	if #history > BUFFER_SIZE then
		table.remove(history, 1)
	end
end

-- Position closest to REWIND_SECONDS ago; falls back to oldest sample,
-- then to the player's spawn if we have no history at all.
local function rewindCFrame(player: Player): CFrame?
	local history = histories[player]
	if not history or #history == 0 then
		return nil
	end
	local target = os.clock() - Config.REWIND_SECONDS
	for _, sample in history do
		if sample.t >= target then
			return sample.cframe
		end
	end
	return history[1].cframe
end

local function makeGhostly(character: Model)
	for _, part in character:GetDescendants() do
		if part:IsA("BasePart") then
			part.Transparency = math.max(part.Transparency, Config.ECHO_TRANSPARENCY)
			part.CanCollide = false
			part.CollisionGroup = "Echoes"
		elseif part:IsA("Decal") then
			part.Transparency = Config.ECHO_TRANSPARENCY
		elseif part:IsA("Tool") then
			part:Destroy() -- echoes are weaponless
		end
	end
end

function RewindService.isEcho(player: Player): boolean
	return echoes[player] == true
end

-- Called by MatchService when a player is eliminated mid-match.
function RewindService.becomeEcho(player: Player)
	if echoes[player] then
		return
	end
	echoes[player] = true
	local spawnCFrame = rewindCFrame(player)

	-- Respawn them, then ghost the new character at the rewound position.
	player:LoadCharacter()
	local character = player.Character or player.CharacterAdded:Wait()
	local root = character:WaitForChild("HumanoidRootPart", 5)
	local humanoid = character:WaitForChild("Humanoid", 5)
	if root and spawnCFrame then
		root.CFrame = spawnCFrame + Vector3.new(0, 3, 0)
	end
	if humanoid then
		humanoid.WalkSpeed = Config.ECHO_WALKSPEED
	end
	makeGhostly(character)
	echoStateRemote:FireClient(player, true)
end

function RewindService.reset(player: Player)
	histories[player] = nil
	if echoes[player] then
		echoes[player] = nil
		echoStateRemote:FireClient(player, false)
	end
end

function RewindService.resetAll()
	for _, player in Players:GetPlayers() do
		RewindService.reset(player)
	end
end

function RewindService.init()
	-- Echoes collide with the world but pass through living players.
	local PhysicsService = game:GetService("PhysicsService")
	pcall(function()
		PhysicsService:RegisterCollisionGroup("Echoes")
		PhysicsService:CollisionGroupSetCollidable("Echoes", "Default", true)
	end)

	local accumulator = 0
	RunService.Heartbeat:Connect(function(dt)
		accumulator += dt
		if accumulator < 1 / Config.SNAPSHOT_HZ then
			return
		end
		accumulator = 0
		for _, player in Players:GetPlayers() do
			if not echoes[player] then
				snapshot(player)
			end
		end
	end)

	Players.PlayerRemoving:Connect(function(player)
		histories[player] = nil
		echoes[player] = nil
	end)
end

return RewindService
