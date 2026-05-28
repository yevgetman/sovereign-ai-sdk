# Config menu — `sov config` standalone mode shows the branded splash
# above the picker card, with the curated 10-group catalog.

Source .harness/visual/scenarios/_preamble.tape
Output .harness/visual/output/_trash/config-menu.gif

Type "sov config"
Enter
Sleep 3s

Screenshot .harness/visual/output/config-menu.png
Sleep 500ms

# Escape from root menu (configOnly mode exits cleanly).
Escape
Sleep 1s
