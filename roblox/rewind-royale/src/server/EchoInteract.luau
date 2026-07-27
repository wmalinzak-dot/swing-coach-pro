-- ModuleScript → ServerScriptService/Server/EchoInteract
-- Lets echoes trigger map objects. In Studio, tag any part with the
-- CollectionService tag "EchoInteractable" and it becomes echo-usable.
--
-- v0 behaviors, chosen by an optional "EchoAction" string attribute:
--   "Toggle"  (default) — flips the part's Transparency/CanCollide,
--              i.e. a door or bridge that appears/disappears
--   "Launch"  — flings nearby unanchored parts upward (loot scatter)

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.Shared.Config)
local RewindService = require(script.Parent.RewindService)

local EchoInteract = {}

local lastUse: { [Player]: number } = {}

local function doToggle(part: BasePart)
	local open = part:GetAttribute("EchoOpen") == true
	part:SetAttribute("EchoOpen", not open)
	part.Transparency = open and 0 or 0.8
	part.CanCollide = open
end

local function doLaunch(part: BasePart)
	local region = Region3.new(part.Position - Vector3.one * 8, part.Position + Vector3.one * 8)
	local overlap = OverlapParams.new()
	for _, nearby in workspace:GetPartBoundsInBox(region.CFrame, region.Size, overlap) do
		if not nearby.Anchored and nearby ~= part then
			nearby:ApplyImpulse(Vector3.new(0, nearby.AssemblyMass * 60, 0))
		end
	end
end

local function onTriggered(player: Player, part: BasePart)
	if not RewindService.isEcho(player) then
		return -- living players use doors the normal way; this path is echo-only
	end
	local now = os.clock()
	if lastUse[player] and now - lastUse[player] < Config.ECHO_INTERACT_COOLDOWN then
		return
	end
	lastUse[player] = now

	local action = part:GetAttribute("EchoAction") or "Toggle"
	if action == "Launch" then
		doLaunch(part)
	else
		doToggle(part)
	end
end

local function attachPrompt(part: BasePart)
	if part:FindFirstChildOfClass("ProximityPrompt") then
		return
	end
	local prompt = Instance.new("ProximityPrompt")
	prompt.ActionText = "Echo Interact"
	prompt.ObjectText = part.Name
	prompt.HoldDuration = 0.5
	prompt.RequiresLineOfSight = false
	prompt.Parent = part
	prompt.Triggered:Connect(function(player)
		onTriggered(player, part)
	end)
end

function EchoInteract.init()
	for _, instance in CollectionService:GetTagged(Config.ECHO_INTERACT_TAG) do
		if instance:IsA("BasePart") then
			attachPrompt(instance)
		end
	end
	CollectionService:GetInstanceAddedSignal(Config.ECHO_INTERACT_TAG):Connect(function(instance)
		if instance:IsA("BasePart") then
			attachPrompt(instance)
		end
	end)
	Players.PlayerRemoving:Connect(function(player)
		lastUse[player] = nil
	end)
end

return EchoInteract
