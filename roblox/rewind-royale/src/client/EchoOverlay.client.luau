-- LocalScript → StarterPlayerScripts/Client/EchoOverlay
-- Tints the screen blue and shows match status text. Minimal v0 UI.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Lighting = game:GetService("Lighting")

local player = Players.LocalPlayer

local screenGui = Instance.new("ScreenGui")
screenGui.Name = "RewindRoyaleHUD"
screenGui.ResetOnSpawn = false
screenGui.Parent = player:WaitForChild("PlayerGui")

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.fromScale(1, 0.06)
statusLabel.Position = UDim2.fromScale(0, 0.02)
statusLabel.BackgroundTransparency = 1
statusLabel.TextScaled = true
statusLabel.Font = Enum.Font.GothamBold
statusLabel.TextColor3 = Color3.new(1, 1, 1)
statusLabel.TextStrokeTransparency = 0.5
statusLabel.Text = "Waiting for players..."
statusLabel.Parent = screenGui

local echoTint = Instance.new("ColorCorrectionEffect")
echoTint.Name = "EchoTint"
echoTint.Enabled = false
echoTint.TintColor = Color3.fromRGB(150, 190, 255)
echoTint.Saturation = -0.5
echoTint.Parent = Lighting

local echoStateRemote = ReplicatedStorage:WaitForChild("EchoStateChanged")
echoStateRemote.OnClientEvent:Connect(function(isEcho: boolean)
	echoTint.Enabled = isEcho
	if isEcho then
		statusLabel.Text = "You are an ECHO — haunt the map, tip the fight"
	end
end)

local statusRemote = ReplicatedStorage:WaitForChild("MatchStatus")
statusRemote.OnClientEvent:Connect(function(message: string)
	local kind, value = string.match(message, "^(%w+):?(.*)$")
	if kind == "Lobby" then
		statusLabel.Text = "Waiting for players..."
	elseif kind == "Countdown" then
		statusLabel.Text = `Match starting in {value}...`
	elseif kind == "Alive" then
		statusLabel.Text = `{value} survivors remain`
	elseif kind == "Winner" then
		statusLabel.Text = `🏆 {value} wins!`
	end
end)
