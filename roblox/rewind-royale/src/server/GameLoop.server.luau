-- Script → ServerScriptService/Server/GameLoop
-- Entry point: boots every service. Order matters — RewindService creates
-- the RemoteEvents the others (and clients) rely on.

local RewindService = require(script.Parent.RewindService)
local EchoInteract = require(script.Parent.EchoInteract)
local MatchService = require(script.Parent.MatchService)

RewindService.init()
EchoInteract.init()
MatchService.init()

print("[RewindRoyale] server booted")
