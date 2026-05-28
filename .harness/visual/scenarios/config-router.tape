# Config router submenu — drills into the router group from the root menu.
# Used to verify the picker drill-in path and the ValueColumn + Badge
# rendering on per-row settings.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/config-router.gif

Type "sov config"
Enter
Sleep 3s

# Root menu order: general(0), providers(1), task-routing(2), router(3).
# Three Downs from the initial position lands on router.
Down
Down
Down
Enter
Sleep 1500ms

Screenshot .harness/visual/output/config-router.png
Sleep 500ms

Escape
Sleep 500ms
Escape
Sleep 500ms
