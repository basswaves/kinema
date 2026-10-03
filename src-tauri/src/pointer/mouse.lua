-- The mouse on mpv's own window, told to Kinema (src/player/mpvMouse.ts).
--
-- Loaded by Kinema where mpv plays in a window of its own (Linux), so the
-- player's page, drawn over the video as a picture, can be pointed at,
-- clicked and dragged like the real page it is. A script because only a
-- script hears a button go down: an ordinary key binding on a mouse button
-- runs when it is released, too late for dragging the seek bar.
--
-- Every event is written to `user-data/kinema/mouse` as one line among the
-- last few — "seq kind x y ms", joined by ";" — because Kinema hears a
-- property's latest value, not every value it had: a click's press and
-- release can land between two readings, and both must arrive. Moves in a
-- row are kept as one, the latest, so the list holds many presses.

local KEEP = 16
local seq = 0
local lines = {}
-- A press mpv could not place is dropped, and so is its release.
local dropping = false

-- Whether mpv knows where the pointer is: it has heard a move since its
-- window opened. Until then it may not — a window opened under a still
-- pointer can be told of a click but not where, and mpv then says 0,0 and
-- that the pointer is over it (seen in a nested GNOME; 0,0 is the corner
-- Back sits in). A click then is not acted on; the first move puts it right.
local seen = false
mp.observe_property("vo-configured", "bool", function(_, open)
    if not open then seen = false end
end)

local function placed()
    return seen
end

local function report(kind)
    local pos = mp.get_property_native("mouse-pos") or {}
    seq = seq + 1
    local line = string.format("%d %s %d %d %d", seq, kind,
        math.floor(pos.x or 0), math.floor(pos.y or 0),
        math.floor(mp.get_time() * 1000))
    if kind == "move" and #lines > 0 and lines[#lines]:match("^%d+ move ") then
        lines[#lines] = line
    else
        lines[#lines + 1] = line
    end
    while #lines > KEEP do table.remove(lines, 1) end
    mp.set_property("user-data/kinema/mouse", table.concat(lines, ";"))
end

mp.add_forced_key_binding("MOUSE_MOVE", "kinema-mouse-move", function()
    seen = true
    report("move")
end)
mp.add_forced_key_binding("MOUSE_LEAVE", "kinema-mouse-leave", function()
    seen = false
    report("leave")
end)
mp.add_forced_key_binding("WHEEL_UP", "kinema-wheel-up", function()
    if placed() then report("wheel-up") end
end)
mp.add_forced_key_binding("WHEEL_DOWN", "kinema-wheel-down", function()
    if placed() then report("wheel-down") end
end)
mp.add_forced_key_binding("MBTN_LEFT", "kinema-mouse-left", function(e)
    if e.event == "down" then
        dropping = not placed()
        if not dropping then report("down") end
    elseif e.event == "up" then
        if not dropping then report("up") end
        dropping = false
    elseif e.event == "press" and placed() then
        -- Up and down could not be told apart: a whole click.
        report("down")
        report("up")
    end
end, { complex = true })
